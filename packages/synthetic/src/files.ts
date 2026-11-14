import { err, Result } from "neverthrow";
import { offsetForNight, type BeforeFirstOffset, type ClockOffset } from "@airway/contract/clock";
import { AIRSENSE, dataSignals } from "@airway/contract/edf/airsense";
import {
  writeAnnotations,
  writeSignals,
  type EdfHeader,
  type EdfWriteError,
} from "@airway/contract/edf/write";
import type { SyntheticNight } from "./model.ts";
import type { MachineEventType } from "./patients.ts";
import { renderBrp } from "./signals.ts";

/** One of a night's EDF files, with its start time on the device's clock. */
export type NightFile = {
  kind: "brp" | "pld" | "sad" | "eve" | "csl";
  start: Temporal.PlainDateTime;
  bytes: Uint8Array;
};

export type SyntheticFileError = EdfWriteError | BeforeFirstOffset | { kind: "no_nights" };

/** How EVE files label each event type. */
const EVENT_LABELS: Readonly<Record<MachineEventType, string>> = {
  obstructive_apnea: "Obstructive Apnea",
  central_apnea: "Central Apnea",
  unclassified_apnea: "Apnea",
  hypopnea: "Hypopnea",
  arousal: "Arousal",
};

const RECORDING_STARTS = { onset: 0, duration: 0, label: "Recording starts" };
// PLD and SAD files start this long after their BRP file, as on the real machine.
const FOLLOWER_SECONDS = 1;
const PATIENT = "X X X X";
const SERIAL = "SYNTHETIC-0001";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// EDF+'s recording field: "Startdate", the date as 07-JAN-2030, then hospital code, technician,
// and equipment, with X for unknown.
const header = (start: Temporal.PlainDateTime): EdfHeader => ({
  start,
  patient: PATIENT,
  recording: `Startdate ${String(start.day).padStart(2, "0")}-${MONTHS[start.month - 1] ?? "X"}-${start.year.toString()} X X ${SERIAL}`,
});

/** A moment as the device's clock shows it: a fixed offset, with no daylight saving time. */
const deviceTime = (at: Temporal.Instant, offset: ClockOffset): Temporal.PlainDateTime =>
  at.toZonedDateTimeISO(offset.utcOffset).toPlainDateTime();

const missing = (length: number): Float64Array => new Float64Array(length).fill(Number.NaN);

/**
 * A night's EDF files: a BRP, PLD, and SAD file for each segment, and one EVE and CSL pair. Each
 * start time uses the night's clock offset. EVE onsets mark each event's end, as the machine
 * writes them.
 */
export function nightFiles(
  night: SyntheticNight,
  offsets: readonly ClockOffset[],
): Result<NightFile[], SyntheticFileError> {
  return offsetForNight(offsets, night.night).andThen((offset) => {
    const segmentFiles = night.segments.map((segment) => {
      const start = deviceTime(segment.start, offset);
      const follower = start.add({ seconds: FOLLOWER_SECONDS });
      const { flow, pressure } = renderBrp(segment, night);
      const seconds = segment.start.until(segment.end).total("seconds");
      const sad = new Map([
        ["Pulse.1s", missing(seconds)],
        ["SpO2.1s", missing(seconds)],
      ]);

      return Result.combine([
        writeSignals(
          AIRSENSE.brp,
          header(start),
          new Map([
            ["Flow.40ms", flow],
            ["Press.40ms", pressure],
          ]),
        ).map((bytes): NightFile => ({ kind: "brp", start, bytes })),
        writeSignals(AIRSENSE.pld, header(follower), segment.pld).map((bytes): NightFile => ({
          kind: "pld",
          start: follower,
          bytes,
        })),
        writeSignals(AIRSENSE.sad, header(follower), sad).map((bytes): NightFile => ({
          kind: "sad",
          start: follower,
          bytes,
        })),
      ]);
    });

    const recordingStart = night.segments[0]?.start;

    if (recordingStart === undefined) {
      return Result.combine(segmentFiles).map((files) => files.flat());
    }

    const start = deviceTime(recordingStart, offset);
    const events = night.events.map((event) => ({
      onset: Math.round(recordingStart.until(event.at).total("seconds") + event.duration),
      duration: event.duration,
      label: EVENT_LABELS[event.type],
    }));
    const annotationFiles = Result.combine([
      writeAnnotations(AIRSENSE.eve, header(start), [RECORDING_STARTS, ...events]).map(
        (bytes): NightFile => ({ kind: "eve", start, bytes }),
      ),
      writeAnnotations(AIRSENSE.csl, header(start), [RECORDING_STARTS]).map((bytes): NightFile => ({
        kind: "csl",
        start,
        bytes,
      })),
    ]);

    return Result.combine([...segmentFiles, annotationFiles]).map((files) => files.flat());
  });
}

const SLOTS = 10;
const EPOCH = Temporal.PlainDate.from("1970-01-01");

/**
 * STR.edf for every day from the earliest night to the latest, one record per day. The nights can
 * come in any order. A day without a night is unused: every value is -1. MaskOn and MaskOff are
 * minutes since noon on the device's clock, for up to 10 periods; unused slots are -1.
 */
export function strFile(
  nights: readonly SyntheticNight[],
  offsets: readonly ClockOffset[],
): Result<Uint8Array, SyntheticFileError> {
  const sorted = [...nights].sort((a, b) => Temporal.PlainDate.compare(a.night, b.night));
  const [first] = sorted;
  const last = sorted.at(-1);

  if (first === undefined || last === undefined) {
    return err({ kind: "no_nights" });
  }

  const days = first.night.until(last.night).days + 1;
  const byDate = new Map(nights.map((night) => [night.night.toString(), night]));
  const values = new Map(
    dataSignals(AIRSENSE.str).map((signal) => [
      signal.label,
      missing(days * signal.samplesPerRecord),
    ]),
  );
  const put = (label: string, index: number, value: number): void => {
    values.get(label)?.set([value], index);
  };

  for (let day = 0; day < days; day += 1) {
    const date = first.night.add({ days: day });
    const night = byDate.get(date.toString());

    if (night === undefined) {
      continue;
    }

    const offset = offsetForNight(offsets, date);

    if (offset.isErr()) {
      return err(offset.error);
    }

    const noon = date.toPlainDateTime("12:00");
    const minutes = (at: Temporal.Instant): number =>
      Math.floor(noon.until(deviceTime(at, offset.value)).total("minutes"));

    put("Date", day, EPOCH.until(date).days);
    night.periods.slice(0, SLOTS).forEach(({ on, off }, slot) => {
      put("MaskOn", day * SLOTS + slot, minutes(on));
      put("MaskOff", day * SLOTS + slot, minutes(off));
    });
    for (const [label, value] of night.str) {
      put(label, day, value);
    }
  }

  return writeSignals(AIRSENSE.str, header(first.night.toPlainDateTime("12:00")), values);
}
