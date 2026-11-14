import crc16ccitt from "crc/calculators/crc16ccitt";
import { err, ok, Result } from "neverthrow";
import { dataSignals, step, type EdfFile, type EdfSignal } from "./airsense.ts";

/** The header fields that change from file to file. */
export type EdfHeader = {
  /** The device clock's time, which has no zone, as the machine writes it. */
  start: Temporal.PlainDateTime;
  patient: string;
  recording: string;
};

/** One EDF+ annotation, with times in seconds from the file's start. */
export type Annotation = { onset: number; duration: number; label: string };

export type EdfWriteError =
  | { kind: "missing_signal"; label: string }
  | { kind: "partial_record"; label: string; samples: number }
  | { kind: "missing_not_representable"; label: string }
  | { kind: "uneven_signals"; label: string; records: number; expected: number }
  | { kind: "field_too_long"; field: string; value: string }
  | { kind: "annotation_too_long"; annotation: Annotation };

const HEADER_BYTES = 256;
const SIGNAL_HEADER_BYTES = 256;
// The machine's marker for "no value", written in place of NaN.
const MISSING = -1;

const encoder = new TextEncoder();

/** Fills a header with fixed-width text fields, left-aligned and padded with spaces. */
class HeaderBuilder {
  readonly bytes: Uint8Array;
  #offset = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length).fill(0x20);
  }

  // Widths count bytes, not characters: "°C" takes 3 bytes in UTF-8.
  field(name: string, value: string, width: number): Result<void, EdfWriteError> {
    const encoded = encoder.encode(value);

    if (encoded.length > width) {
      return err({ kind: "field_too_long", field: name, value });
    }

    this.bytes.set(encoded, this.#offset);
    this.#offset += width;

    return ok(undefined);
  }
}

const two = (value: number): string => value.toString().padStart(2, "0");

function writeHeader(
  file: EdfFile,
  header: EdfHeader,
  records: number,
): Result<Uint8Array, EdfWriteError> {
  const { signals } = file;
  const headerBytes = HEADER_BYTES + SIGNAL_HEADER_BYTES * signals.length;
  const builder = new HeaderBuilder(headerBytes);
  const { start } = header;
  // A field's offset follows from the widths of the fields before it, so order matters.
  const fields: [string, string, number][] = [
    ["version", "0", 8],
    ["patient", header.patient, 80],
    ["recording", header.recording, 80],
    ["start date", `${two(start.day)}.${two(start.month)}.${two(start.year % 100)}`, 8],
    ["start time", `${two(start.hour)}.${two(start.minute)}.${two(start.second)}`, 8],
    ["header bytes", headerBytes.toString(), 8],
    ["reserved", file.format, 44],
    ["records", records.toString(), 8],
    ["record duration", file.recordSeconds.toFixed(2), 8],
    ["signals", signals.length.toString(), 4],
    ...perSignal(signals, "label", 16, (signal) => signal.label),
    ...perSignal(signals, "transducer", 80, () => ""),
    ...perSignal(signals, "unit", 8, (signal) => signal.unit),
    ...perSignal(signals, "physical minimum", 8, (signal) => signal.physicalMin),
    ...perSignal(signals, "physical maximum", 8, (signal) => signal.physicalMax),
    ...perSignal(signals, "digital minimum", 8, (signal) => signal.digitalMin.toString()),
    ...perSignal(signals, "digital maximum", 8, (signal) => signal.digitalMax.toString()),
    ...perSignal(signals, "prefiltering", 80, () => ""),
    ...perSignal(signals, "samples per record", 8, (signal) => signal.samplesPerRecord.toString()),
    ...perSignal(signals, "signal reserved", 32, () => ""),
  ];

  return Result.combine(
    fields.map(([name, value, width]) => builder.field(name, value, width)),
  ).map(() => builder.bytes);
}

// The signal headers store each field for every signal before the next field.
function perSignal(
  signals: readonly EdfSignal[],
  name: string,
  width: number,
  value: (signal: EdfSignal) => string,
): [string, string, number][] {
  return signals.map((signal) => [`${signal.label} ${name}`, value(signal), width]);
}

// A signal's samples as digital values, in one pass. NaN becomes the machine's -1, which is an
// error where -1 is inside the digital range, because it would read back as a value.
function digitize(signal: EdfSignal, samples: Float64Array): Result<Int16Array, EdfWriteError> {
  const physicalMin = Number(signal.physicalMin);
  const size = step(signal);
  const missingAllowed = signal.digitalMin > MISSING || signal.digitalMax < MISSING;
  const digital = new Int16Array(samples.length);

  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;

    if (Number.isNaN(value)) {
      if (!missingAllowed) {
        return err({ kind: "missing_not_representable", label: signal.label });
      }

      digital[i] = MISSING;
    } else {
      const rounded = Math.round(signal.digitalMin + (value - physicalMin) / size);

      digital[i] = Math.min(signal.digitalMax, Math.max(signal.digitalMin, rounded));
    }
  }

  return ok(digital);
}

const recordBytes = (file: EdfFile): number =>
  2 * file.signals.reduce((sum, signal) => sum + signal.samplesPerRecord, 0);

// Every record ends with its Crc16 sample: the CRC-16/CCITT-FALSE of the record's other bytes,
// little-endian, as the AirSense writes it.
function signRecords(bytes: Uint8Array, first: number, size: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let start = first; start < bytes.length; start += size) {
    const end = start + size - 2;

    view.setUint16(end, crc16ccitt(bytes.subarray(start, end)), true);
  }

  return bytes;
}

// Every signal must fill the same whole number of records. Crc16 isn't passed in.
function recordCount(
  file: EdfFile,
  values: ReadonlyMap<string, Float64Array>,
): Result<number, EdfWriteError> {
  const counts: { label: string; records: number }[] = [];

  for (const signal of dataSignals(file)) {
    const samples = values.get(signal.label);

    if (samples === undefined) {
      return err({ kind: "missing_signal", label: signal.label });
    }

    if (samples.length % signal.samplesPerRecord !== 0) {
      return err({ kind: "partial_record", label: signal.label, samples: samples.length });
    }

    counts.push({ label: signal.label, records: samples.length / signal.samplesPerRecord });
  }

  const [first] = counts;
  const expected = first?.records ?? 0;
  const uneven = counts.find(({ records }) => records !== expected);

  return uneven === undefined ? ok(expected) : err({ kind: "uneven_signals", ...uneven, expected });
}

/**
 * Writes a signal file (BRP, PLD, SAD, or STR) from physical values, one array per label. Values
 * are rounded to the signal's step and clamped to its digital range; `NaN` is written as the
 * machine's -1 for "no value", which only signals whose digital range leaves out -1 accept. Each
 * record ends with its checksum.
 */
export function writeSignals(
  file: EdfFile,
  header: EdfHeader,
  values: ReadonlyMap<string, Float64Array>,
): Result<Uint8Array, EdfWriteError> {
  const signals = dataSignals(file);

  return recordCount(file, values)
    .andThen((records) =>
      Result.combine(
        signals.map((signal) => digitize(signal, values.get(signal.label) ?? new Float64Array())),
      ).map((digital) => ({ records, digital })),
    )
    .andThen(({ records, digital }) =>
      writeHeader(file, header, records).map((headerBytes) => {
        const bytes = new Uint8Array(headerBytes.length + records * recordBytes(file));
        // Int16Array writes the host's byte order. EDF is little-endian, as are the hosts airway runs
        // on. The header's length is a multiple of 256, so the data starts on a 2-byte boundary.
        const samples = new Int16Array(bytes.buffer, headerBytes.length);
        const stride = recordBytes(file) / 2;

        bytes.set(headerBytes);

        // Each record holds every signal's next run of samples in header order. The trailing
        // Crc16 is left at 0 for signRecords to fill.
        for (let record = 0; record < records; record += 1) {
          let offset = record * stride;

          for (const [i, { samplesPerRecord: per }] of signals.entries()) {
            samples.set(digital[i]?.subarray(record * per, (record + 1) * per) ?? [], offset);
            offset += per;
          }
        }

        return signRecords(bytes, headerBytes.length, recordBytes(file));
      }),
    );
}

/**
 * Writes an EDF+D annotation file (EVE or CSL), one annotation per data record, as the machine
 * does. Each record starts with the timekeeping entry EDF+ requires, then holds the annotation,
 * padded with zeros. Each record ends with its checksum.
 */
export function writeAnnotations(
  file: EdfFile,
  header: EdfHeader,
  annotations: readonly Annotation[],
): Result<Uint8Array, EdfWriteError> {
  const [annotationSignal] = file.signals;
  const capacity = 2 * (annotationSignal?.samplesPerRecord ?? 0);
  const records: Uint8Array[] = [];

  for (const annotation of annotations) {
    const text = `+0\x14\x14\0+${annotation.onset.toString()}\x15${annotation.duration.toString()}\x14${annotation.label}\x14\0`;
    const encoded = encoder.encode(text);

    if (encoded.length > capacity) {
      return err({ kind: "annotation_too_long", annotation });
    }

    records.push(encoded);
  }

  return writeHeader(file, header, records.length).map((headerBytes) => {
    const size = recordBytes(file);
    const bytes = new Uint8Array(headerBytes.length + records.length * size);

    bytes.set(headerBytes);
    records.forEach((record, i) => {
      bytes.set(record, headerBytes.length + i * size);
    });

    return signRecords(bytes, headerBytes.length, size);
  });
}
