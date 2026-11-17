import { err, ok, type Result } from "neverthrow";
import { step } from "./airsense.ts";
import { coversRecords, recordBytes, type EdfReadError, type ReadableEdfFile } from "./header.ts";

/** Which records to read, with `Array.slice`'s rules: 0-based, `toRecord` exclusive. */
export type RecordRange = { fromRecord?: number; toRecord?: number };

/**
 * Reads the named signals' samples in physical units, one array per label.
 *
 * Reads every whole record on disk by default, including records past the header's count. A
 * digital value outside the signal's digital range reads as NaN: that's how the card marks a
 * missing sample. Signals not asked for, Crc16 among them, are skipped.
 */
export function readSignals<L extends string>(
  bytes: Uint8Array,
  file: ReadableEdfFile,
  labels: readonly L[],
  range: RecordRange = {},
): Result<Record<L, Float64Array>, EdfReadError> {
  const { header } = file;
  const { records } = file.size;
  const { fromRecord = 0, toRecord = records } = range;

  if (
    !Number.isInteger(fromRecord) ||
    !Number.isInteger(toRecord) ||
    fromRecord < 0 ||
    fromRecord > toRecord ||
    toRecord > records
  ) {
    return err({ kind: "range_out_of_bounds", fromRecord, toRecord, records });
  }

  const covered = coversRecords(bytes, header, toRecord);

  if (covered.isErr()) {
    return err(covered.error);
  }

  const stride = recordBytes(header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Each signal's byte offset within a record: the samples of the signals before it.
  const offsets = header.signals.map((_, i) =>
    header.signals.slice(0, i).reduce((sum, signal) => sum + 2 * signal.samplesPerRecord, 0),
  );
  const result: Partial<Record<L, Float64Array>> = {};

  for (const label of labels) {
    const index = header.signals.findIndex((signal) => signal.label === label);
    const signal = header.signals[index];

    if (signal === undefined) {
      return err({ kind: "missing_signal", label });
    }

    const { samplesPerRecord: per, digitalMin, digitalMax } = signal;
    const physicalMin = Number(signal.physicalMin);
    const scale = step(signal);
    const values = new Float64Array((toRecord - fromRecord) * per);
    let i = 0;

    for (let record = fromRecord; record < toRecord; record += 1) {
      const start = header.headerBytes + record * stride + (offsets[index] ?? 0);

      for (let sample = 0; sample < per; sample += 1) {
        const digital = view.getInt16(start + 2 * sample, true);

        values[i] =
          digital < digitalMin || digital > digitalMax
            ? Number.NaN
            : physicalMin + (digital - digitalMin) * scale;
        i += 1;
      }
    }

    result[label] = values;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop sets every label or returns
  return ok(result as Record<L, Float64Array>);
}
