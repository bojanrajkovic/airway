import { err, ok, type Result } from "neverthrow";
import { step } from "./airsense.ts";
import {
  coversRecords,
  recordBytes,
  type EdfHeader,
  type EdfReadError,
  type ReadableEdfFile,
} from "./header.ts";

/**
 * Selects the records to read. Records are numbered from 0, and the range ends just before
 * `toRecord`, as in `Array.slice`.
 */
export type RecordRange = { fromRecord?: number; toRecord?: number };

/**
 * Reads the samples of the signals named in `labels` and returns them in physical units, one
 * array per label.
 *
 * Reads every whole record on disk by default, including records past the header's count. The
 * machine marks a missing sample with a digital value outside the signal's digital range.
 * `readSignals` returns NaN for any such value. It skips the signals that aren't in `labels`, such
 * as Crc16.
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

  return coversRecords(bytes, header, toRecord).andThen(() =>
    decode(bytes, header, labels, { fromRecord, toRecord }),
  );
}

// Decodes the records in [fromRecord, toRecord) for each label. `readSignals` has already
// checked the range.
function decode<L extends string>(
  bytes: Uint8Array,
  header: EdfHeader,
  labels: readonly L[],
  { fromRecord, toRecord }: Required<RecordRange>,
): Result<Record<L, Float64Array>, EdfReadError> {
  const stride = recordBytes(header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A record stores the signals' samples back to back, in header order.
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop sets a value for every label or returns an error
  return ok(result as Record<L, Float64Array>);
}
