import { err, ok, Result } from "neverthrow";
import { toDeviceTime } from "@airway/contract/clock";
import {
  AIRSENSE,
  dataSignals,
  EVENT_LABELS,
  PLD_SAMPLE_SECONDS,
  type DataLabel,
} from "@airway/edf/airsense";
import { readHeader, type EdfReadError } from "@airway/edf/header";
import type { FileSizeCheck } from "@airway/edf/size";
import {
  samplesFor,
  writeAnnotations,
  writeSignals,
  type EdfWriteError,
  type PerFileHeader,
} from "@airway/edf/write";
import {
  isNightStrLabel,
  type EventFile,
  type FileDamage,
  type MachineEvent,
  type PldSeries,
  type Segment,
  type SyntheticNight,
} from "./model.ts";
import { APNEAS } from "./patients.ts";
import { renderBrp } from "./signals.ts";

/**
 * Describes one of a night's EDF files. `start` is the file's start time on the device's clock.
 * `segment` is the index of the segment that the file belongs to, and is null for an EVE or CSL
 * file.
 */
export type NightFile = {
  kind: "brp" | "pld" | "sad" | "eve" | "csl";
  start: Temporal.PlainDateTime;
  bytes: Uint8Array;
  segment: number | null;
};

export type SyntheticFileError = EdfWriteError | EdfReadError | { kind: "no_nights" };

/**
 * Returns the duration that the machine writes to EVE for `event`. The machine times only apneas,
 * so it writes 0 for a hypopnea or arousal.
 */
export const writtenDuration = (event: MachineEvent): number =>
  APNEAS.has(event.type) ? event.duration : 0;

const RECORDING_STARTS = { onset: 0, duration: 0, label: "Recording starts" };
/** PLD and SAD files start this long after their BRP file, as on the real machine. */
export const PLD_LAG_SECONDS = 1;
const EDF_PATIENT_FIELD = "X X X X";
/** Every synthetic file names this invented machine. */
export const DEVICE = { serial: "SYNTHETIC-0001", model: "AirSense_10_AutoSet" };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// The EDF+ recording field is "Startdate", the date written as 07-JAN-2030, then the hospital
// code, the technician, and the equipment. An X stands for an unknown value.
const header = (start: Temporal.PlainDateTime): PerFileHeader => ({
  start,
  patient: EDF_PATIENT_FIELD,
  recording: `Startdate ${String(start.day).padStart(2, "0")}-${MONTHS[start.month - 1] ?? "X"}-${start.year.toString()} X X ${DEVICE.serial}`,
});

const missing = (length: number): Float64Array => new Float64Array(length).fill(Number.NaN);

/**
 * Returns a night's EDF files. The function writes BRP, PLD, and SAD files for each segment, and
 * an EVE file for each entry in `eventFiles`. It also writes a CSL file for an entry that sets
 * `withCsl`. Each start time is on the device clock. Like the machine, this function writes each
 * event's end as its EVE onset.
 */
export function nightFiles(
  night: SyntheticNight,
  zone: string,
): Result<NightFile[], SyntheticFileError> {
  const segmentFiles = night.segments.map((segment, i) => {
    const start = toDeviceTime(segment.start, zone);
    const pldSadStart = start.add({ seconds: PLD_LAG_SECONDS });
    const { flow, pressure } = renderBrp(segment, night);
    const seconds = segment.start.until(segment.end).total("seconds");
    const sad = { "Pulse.1s": missing(seconds), "SpO2.1s": missing(seconds) };
    const file =
      (kind: NightFile["kind"], at: Temporal.PlainDateTime, damage: FileDamage) =>
      (bytes: Uint8Array): NightFile[] => [
        { kind, start: at, bytes: applyDamage(bytes, damage), segment: i },
      ];

    return Result.combine([
      writeSignals(AIRSENSE.brp, header(start), { "Flow.40ms": flow, "Press.40ms": pressure }).map(
        file("brp", start, segment.brp),
      ),
      ...pldParts(segment).map(({ series, offsetSeconds, damage }) => {
        const at = pldSadStart.add({ seconds: offsetSeconds });

        return writeSignals(AIRSENSE.pld, header(at), series).map(file("pld", at, damage));
      }),
      writeSignals(AIRSENSE.sad, header(pldSadStart), sad).map(
        file("sad", pldSadStart, segment.sad),
      ),
    ]).map((files) => files.flat());
  });

  const annotationFiles = night.eventFiles.map((file) => {
    const start = toDeviceTime(file.start, zone);
    const events = night.events
      .filter((event) => eventFileFor(night, event.at) === file)
      .map((event) => ({
        onset: eventOnset(file, event),
        duration: writtenDuration(event),
        label: EVENT_LABELS[event.type],
      }));

    return Result.combine([
      writeAnnotations(AIRSENSE.eve, header(start), [RECORDING_STARTS, ...events]).map(
        (bytes): NightFile[] => [{ kind: "eve", start, bytes, segment: null }],
      ),
      file.withCsl
        ? writeAnnotations(AIRSENSE.csl, header(start), [RECORDING_STARTS]).map(
            (bytes): NightFile[] => [{ kind: "csl", start, bytes, segment: null }],
          )
        : ok<NightFile[], SyntheticFileError>([]),
    ]).map((files) => files.flat());
  });

  return Result.combine([...segmentFiles, ...annotationFiles]).map((files) => files.flat());
}

/**
 * Returns the last EVE file that starts at or before an event. `nightFiles` writes the event to
 * that file.
 */
export const eventFileFor = (night: SyntheticNight, at: Temporal.Instant): EventFile | undefined =>
  night.eventFiles.findLast((file) => Temporal.Instant.compare(file.start, at) <= 0) ??
  night.eventFiles[0];

/**
 * Returns an event's EVE onset, which is the number of whole seconds from the start of its EVE
 * file to the event's end.
 */
export const eventOnset = (file: EventFile, event: MachineEvent): number =>
  Math.round(file.start.until(event.at).total("seconds") + event.duration);

type PldPart = {
  series: PldSeries;
  offsetSeconds: number;
  damage: FileDamage;
};

const PLD_RECORD_SAMPLES = AIRSENSE.pld.header.recordSeconds / PLD_SAMPLE_SECONDS;

// Returns one entry per PLD file, depending on `pldFiles.files`:
// - `none`: no entries
// - `one`: the whole series
// - `split`: the series split in two at record `atRecord`
function pldParts({ pldSeries, pldFiles }: Segment): PldPart[] {
  if (pldFiles.files === "none") {
    return [];
  }

  if (pldFiles.files === "one") {
    return [{ series: pldSeries, offsetSeconds: 0, damage: pldFiles.damage }];
  }

  const at = pldFiles.atRecord * PLD_RECORD_SAMPLES;
  const part = (from: number, to?: number): PldSeries =>
    samplesFor(AIRSENSE.pld, ({ label }) => pldSeries[label].subarray(from, to));

  return [
    { series: part(0, at), offsetSeconds: 0, damage: "none" },
    { series: part(at), offsetSeconds: at * PLD_SAMPLE_SECONDS, damage: "none" },
  ];
}

const HEADER_BYTES_FIELD = { at: 184, width: 8 };
const RECORDS_FIELD = { at: 236, width: 8 };
const ascii = new TextDecoder();

const field = (bytes: Uint8Array, { at, width }: typeof RECORDS_FIELD): number =>
  Number(ascii.decode(bytes.subarray(at, at + width)));

// Returns a copy of the file with `count` as the record count in its header.
function withCount(bytes: Uint8Array, count: number): Uint8Array {
  const copy = bytes.slice();

  copy.set(
    new TextEncoder().encode(count.toString().padEnd(RECORDS_FIELD.width)),
    RECORDS_FIELD.at,
  );

  return copy;
}

// Returns `bytes` damaged in the way that `damage` names. The damage leaves each record's Crc16
// unchanged.
function applyDamage(bytes: Uint8Array, damage: FileDamage): Uint8Array {
  const headerBytes = field(bytes, HEADER_BYTES_FIELD);
  const records = field(bytes, RECORDS_FIELD);
  const recordSize = (bytes.length - headerBytes) / Math.max(1, records);

  switch (damage) {
    case "none":
      return bytes;
    case "empty":
      return withCount(bytes.slice(0, headerBytes), -1);
    case "unknown_length":
      return withCount(bytes, -1);
    case "undercounted":
      return withCount(bytes, records - 1);
    case "truncated":
      // Keeps half the file's records, then 7 bytes of the next record.
      return bytes.slice(0, headerBytes + Math.floor(records / 2) * recordSize + 7);
  }
}

/** Parses a written file's header as ingest does, and returns the header's size check. */
export const sizeCheck = (file: NightFile): Result<FileSizeCheck, EdfReadError> =>
  readHeader(file.bytes).map(({ size }) => size);

const SLOTS = 10;
const EPOCH = Temporal.PlainDate.from("1970-01-01");

/**
 * Lists a night's MaskOn and MaskOff values as STR.edf stores them, in whole minutes since noon
 * on the device clock.
 */
export type MaskSlots = { maskOn: number[]; maskOff: number[] };

/**
 * Returns the night's first 10 mask-on periods as STR.edf records them. STR.edf puts a mask-on
 * before the night's noon in the previous day's record, so this function writes NaN for that
 * mask-on.
 */
export function maskSlots(night: SyntheticNight, zone: string): MaskSlots {
  const noon = night.night.toPlainDateTime("12:00");
  const minutes = (at: Temporal.Instant): number =>
    Math.floor(noon.until(toDeviceTime(at, zone)).total("minutes"));
  const periods = night.periods.slice(0, SLOTS);

  return {
    maskOn: periods.map(({ on }) => (minutes(on) < 0 ? Number.NaN : minutes(on))),
    maskOff: periods.map(({ off }) => minutes(off)),
  };
}

/**
 * Returns STR.edf with one record for every day from the earliest night to the latest. The nights can
 * come in any order. A day without a night is unused, and every value except its Date is -1. MaskOn and MaskOff are
 * minutes since noon on the device's clock, for up to 10 periods; unused slots are -1.
 */
export function strFile(
  nights: readonly SyntheticNight[],
  zone: string,
): Result<Uint8Array, SyntheticFileError> {
  const sorted = [...nights].sort((a, b) => Temporal.PlainDate.compare(a.night, b.night));
  const [first] = sorted;
  const last = sorted.at(-1);

  if (first === undefined || last === undefined) {
    return err({ kind: "no_nights" });
  }

  const days = first.night.until(last.night).days + 1;
  const byDate = new Map(nights.map((night) => [night.night.toString(), night]));
  const values = samplesFor(AIRSENSE.str, (signal) => missing(days * signal.samplesPerRecord));
  const put = (label: DataLabel<typeof AIRSENSE.str>, index: number, value: number): void => {
    values[label].set([value], index);
  };

  for (let day = 0; day < days; day += 1) {
    const date = first.night.add({ days: day });
    const night = byDate.get(date.toString());

    put("Date", day, EPOCH.until(date).days);

    if (night === undefined) {
      continue;
    }

    const slots = maskSlots(night, zone);

    slots.maskOn.forEach((minutes, slot) => {
      put("MaskOn", day * SLOTS + slot, minutes);
    });
    slots.maskOff.forEach((minutes, slot) => {
      put("MaskOff", day * SLOTS + slot, minutes);
    });
    for (const { label } of dataSignals(AIRSENSE.str)) {
      if (isNightStrLabel(label)) {
        put(label, day, night.str[label]);
      }
    }
  }

  return writeSignals(AIRSENSE.str, header(first.night.toPlainDateTime("12:00")), values);
}
