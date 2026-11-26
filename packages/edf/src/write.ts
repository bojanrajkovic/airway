import crc16ccitt from "crc/calculators/crc16ccitt";
import { err, ok, Result } from "neverthrow";
import {
  dataSignals,
  step,
  type DataLabel,
  type EdfAnnotationFileType,
  type EdfFileType,
  type EdfSignalFileType,
} from "./airsense.ts";
import type { EdfAnnotation } from "./annotations.ts";
import { recordBytes, type EdfHeader, type EdfSignalHeader } from "./header.ts";
import type { EdfSamples } from "./signals.ts";

/** These header fields change from file to file. The file type sets the rest. */
export type PerFileHeader = Pick<EdfHeader, "start" | "patient" | "recording">;

export type EdfWriteError =
  | { kind: "partial_record"; label: string; samples: number }
  | { kind: "missing_not_representable"; label: string }
  | { kind: "uneven_signals"; label: string; records: number; expected: number }
  | { kind: "field_too_long"; field: string; value: string }
  | { kind: "annotation_too_long"; annotation: EdfAnnotation }
  // The machine writes every onset at or after the file's start.
  | { kind: "negative_onset"; annotation: EdfAnnotation };

const HEADER_BYTES = 256;
const SIGNAL_HEADER_BYTES = 256;
// The machine marks "no value" with -1. digitize writes -1 in place of NaN.
const MISSING = -1;

const encoder = new TextEncoder();

/** Builds the `EdfSamples` record for `file` by calling `samples` once for each signal except Crc16. */
export const samplesFor = <F extends EdfSignalFileType>(
  file: F,
  samples: (signal: EdfSignalHeader<DataLabel<F>>) => Float64Array,
): EdfSamples<DataLabel<F>> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dataSignals lists every DataLabel<F>, but Object.fromEntries types its keys as string
  Object.fromEntries(
    dataSignals(file).map((signal) => [signal.label, samples(signal)]),
  ) as EdfSamples<DataLabel<F>>;

/** Fills a header with fixed-width text fields, left-aligned and padded with spaces. */
class HeaderBuilder {
  readonly bytes: Uint8Array;
  #offset = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length).fill(0x20);
  }

  // `width` is in bytes. "°C" is 3 bytes in UTF-8.
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
  file: EdfFileType,
  header: PerFileHeader,
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
    ["reserved", file.header.format, 44],
    ["records", records.toString(), 8],
    ["record duration", file.header.recordSeconds.toFixed(2), 8],
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

function perSignal(
  signals: readonly EdfSignalHeader[],
  name: string,
  width: number,
  value: (signal: EdfSignalHeader) => string,
): [string, string, number][] {
  return signals.map((signal) => [`${signal.label} ${name}`, value(signal), width]);
}

function digitize(
  signal: EdfSignalHeader,
  samples: Float64Array,
): Result<Int16Array, EdfWriteError> {
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

// Every record ends with its Crc16 sample, which is the CRC-16/CCITT-FALSE of the record's other
// bytes in little-endian order. The AirSense writes the same checksum.
function signRecords(bytes: Uint8Array, first: number, size: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let start = first; start < bytes.length; start += size) {
    const end = start + size - 2;

    view.setUint16(end, crc16ccitt(bytes.subarray(start, end)), true);
  }

  return bytes;
}

// Every signal must fill the same whole number of records.
function recordCount<F extends EdfSignalFileType>(
  file: F,
  values: EdfSamples<DataLabel<F>>,
): Result<number, EdfWriteError> {
  const counts: { label: string; records: number }[] = [];

  for (const signal of dataSignals(file)) {
    const samples = values[signal.label];

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
 * Writes a signal file (BRP, PLD, SAD, or STR) from physical values, one array per label.
 * docs/synthetic-data.md describes the rounding and how `NaN` is written.
 */
export function writeSignals<F extends EdfSignalFileType>(
  file: F,
  header: PerFileHeader,
  values: EdfSamples<DataLabel<F>>,
): Result<Uint8Array, EdfWriteError> {
  const signals = dataSignals(file);

  return recordCount(file, values)
    .andThen((records) =>
      Result.combine(signals.map((signal) => digitize(signal, values[signal.label]))).map(
        (digital) => ({ records, digital }),
      ),
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
 * does. Each record starts with the timekeeping entry that EDF+ requires. The annotation follows,
 * padded with zeros, and the checksum ends the record.
 */
export function writeAnnotations(
  file: EdfAnnotationFileType,
  header: PerFileHeader,
  annotations: readonly EdfAnnotation[],
): Result<Uint8Array, EdfWriteError> {
  const [annotationSignal] = file.signals;
  const capacity = 2 * (annotationSignal?.samplesPerRecord ?? 0);
  const records: Uint8Array[] = [];

  for (const annotation of annotations) {
    if (annotation.onset < 0) {
      return err({ kind: "negative_onset", annotation });
    }

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
