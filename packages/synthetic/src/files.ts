import { err, ok, Result } from "neverthrow";
import { toDeviceTime } from "@airway/contract/clock";
import { AIRSENSE, dataSignals, PLD_SAMPLE_SECONDS } from "@airway/edf/airsense";
import { checkFileSize, type FileSizeCheck } from "@airway/edf/size";
import { recordBytes } from "@airway/edf/header";
import {
  writeAnnotations,
  writeSignals,
  type EdfWriteError,
  type PerFileHeader,
} from "@airway/edf/write";
import type { EventFile, FileDamage, MachineEvent, Segment, SyntheticNight } from "./model.ts";
import type { MachineEventType } from "./patients.ts";
import { renderBrp } from "./signals.ts";

/**
 * One of a night's EDF files, with its start time on the device's clock and the index of the
 * segment it belongs to (null for EVE and CSL).
 */
export type NightFile = {
  kind: "brp" | "pld" | "sad" | "eve" | "csl";
  start: Temporal.PlainDateTime;
  bytes: Uint8Array;
  segment: number | null;
};

export type SyntheticFileError = EdfWriteError | { kind: "no_nights" };

/** How EVE files label each event type. */
export const EVENT_LABELS: Readonly<Record<MachineEventType, string>> = {
  obstructive_apnea: "Obstructive Apnea",
  central_apnea: "Central Apnea",
  unclassified_apnea: "Apnea",
  hypopnea: "Hypopnea",
  arousal: "Arousal",
};

const RECORDING_STARTS = { onset: 0, duration: 0, label: "Recording starts" };
/** PLD and SAD files start this long after their BRP file, as on the real machine. */
export const PLD_LAG_SECONDS = 1;
const EDF_PATIENT_FIELD = "X X X X";
/** The invented machine every synthetic file names. */
export const DEVICE = { serial: "SYNTHETIC-0001", model: "AirSense_10_AutoSet" };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// EDF+'s recording field: "Startdate", the date as 07-JAN-2030, then hospital code, technician,
// and equipment, with X for unknown.
const header = (start: Temporal.PlainDateTime): PerFileHeader => ({
  start,
  patient: EDF_PATIENT_FIELD,
  recording: `Startdate ${String(start.day).padStart(2, "0")}-${MONTHS[start.month - 1] ?? "X"}-${start.year.toString()} X X ${DEVICE.serial}`,
});

const missing = (length: number): Float64Array => new Float64Array(length).fill(Number.NaN);

/**
 * A night's EDF files: a BRP, PLD, and SAD file for each segment, and an EVE file (plus a CSL
 * file when it has one) for each of `eventFiles`. Each start time is on the device clock, which
 * keeps `zone`'s winter offset.
 * EVE onsets mark each event's end, as the machine writes them.
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
    const sad = new Map([
      ["Pulse.1s", missing(seconds)],
      ["SpO2.1s", missing(seconds)],
    ]);
    const file =
      (kind: NightFile["kind"], at: Temporal.PlainDateTime, damage: FileDamage) =>
      (bytes: Uint8Array): NightFile[] => [
        { kind, start: at, bytes: applyDamage(bytes, damage), segment: i },
      ];

    return Result.combine([
      writeSignals(
        AIRSENSE.brp,
        header(start),
        new Map([
          ["Flow.40ms", flow],
          ["Press.40ms", pressure],
        ]),
      ).map(file("brp", start, segment.brp)),
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
        duration: event.duration,
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

/** The EVE file an event goes in: the last one that starts at or before it. */
export const eventFileFor = (night: SyntheticNight, at: Temporal.Instant): EventFile | undefined =>
  night.eventFiles.findLast((file) => Temporal.Instant.compare(file.start, at) <= 0) ??
  night.eventFiles[0];

/** An event's EVE onset: whole seconds from its file's start to the event's end. */
export const eventOnset = (file: EventFile, event: MachineEvent): number =>
  Math.round(file.start.until(event.at).total("seconds") + event.duration);

type PldPart = {
  series: ReadonlyMap<string, Float64Array>;
  offsetSeconds: number;
  damage: FileDamage;
};

const PLD_RECORD_SAMPLES = AIRSENSE.pld.recordSeconds / PLD_SAMPLE_SECONDS;

// The segment's PLD files: none, one, or two halves of its series split at a record.
function pldParts({ pldSeries, pldFiles }: Segment): PldPart[] {
  if (pldFiles.files === "none") {
    return [];
  }

  if (pldFiles.files === "one") {
    return [{ series: pldSeries, offsetSeconds: 0, damage: pldFiles.damage }];
  }

  const at = pldFiles.atRecord * PLD_RECORD_SAMPLES;
  const part = (from: number, to?: number): Map<string, Float64Array> =>
    new Map([...pldSeries].map(([label, values]) => [label, values.subarray(from, to)]));

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

// A copy of the file with its header's record count replaced.
function withCount(bytes: Uint8Array, count: number): Uint8Array {
  const copy = bytes.slice();

  copy.set(
    new TextEncoder().encode(count.toString().padEnd(RECORDS_FIELD.width)),
    RECORDS_FIELD.at,
  );

  return copy;
}

// Damages a whole file the way `damage` says. Each record keeps its Crc16.
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
      // Half its records, then 7 bytes of the next.
      return bytes.slice(0, headerBytes + Math.floor(records / 2) * recordSize + 7);
  }
}

/** How ingest treats a written file: `checkFileSize` over its size and header. */
export function sizeCheck(file: NightFile): FileSizeCheck {
  return checkFileSize({
    size: file.bytes.length,
    headerBytes: field(file.bytes, HEADER_BYTES_FIELD),
    recordBytes: recordBytes(AIRSENSE[file.kind]),
    declaredRecords: field(file.bytes, RECORDS_FIELD),
  });
}

const SLOTS = 10;
const EPOCH = Temporal.PlainDate.from("1970-01-01");

/** STR.edf's MaskOn and MaskOff for a night: whole minutes since noon on the device clock. */
export type MaskSlots = { maskOn: number[]; maskOff: number[] };

/**
 * The night's first 10 mask-on periods as STR.edf records them. A mask-on before the night's noon
 * is in the previous day's record, so its slot has no mask-on (NaN).
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
 * STR.edf for every day from the earliest night to the latest, one record per day. The nights can
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
    for (const [label, value] of night.str) {
      put(label, day, value);
    }
  }

  return writeSignals(AIRSENSE.str, header(first.night.toPlainDateTime("12:00")), values);
}
