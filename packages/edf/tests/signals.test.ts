import { describe, expect, it } from "vitest";
import { isReadable, readHeader, type ReadableEdfFile } from "../src/header.ts";
import { readSignals, type RecordRange } from "../src/signals.ts";
import { crc16, flow, plain, withSamples, type HeaderFields, type SignalFields } from "./bytes.ts";

// Leak: 0.02 L/s per step over digital 0..100, so the card's -1 for "no value" is out of range.
const leak: SignalFields = {
  label: "Leak.2s",
  unit: "L/s",
  physicalMin: "0",
  physicalMax: "2",
  digitalMin: "0",
  digitalMax: "100",
  samples: "1",
};
const fields = (records: number): HeaderFields =>
  plain({ records: records.toString(), signals: [flow, leak, crc16] });
// Each record: two Flow samples, one Leak sample, and a Crc16 the reader skips.
const record = (n: number): number[] => [n, -n, n, 0x7f7f];

function readable(bytes: Uint8Array): ReadableEdfFile {
  const file = readHeader(bytes)._unsafeUnwrap();

  if (!isReadable(file)) {
    throw new Error(`expected a readable file, got ${JSON.stringify(file.size)}`);
  }

  return file;
}

describe("readSignals", () => {
  it("scales digital values to physical units", () => {
    const bytes = withSamples(fields(2), [
      [1, -50, 50, 0],
      [32767, -32768, -1, 0],
    ]);
    const signals = readSignals(bytes, readable(bytes), ["Flow.40ms", "Leak.2s"])._unsafeUnwrap();

    // Flow: -655.36 + (digital + 32768) × 0.02. Leak: digital × 0.02.
    expect(Array.from(signals["Flow.40ms"])).toEqual([
      expect.closeTo(0.02, 10),
      expect.closeTo(-1, 10),
      expect.closeTo(655.34, 10),
      expect.closeTo(-655.36, 10),
    ]);
    expect(Array.from(signals["Leak.2s"])).toEqual([expect.closeTo(1, 10), Number.NaN]);
  });

  it("reads a record range the same as slicing a full read", () => {
    const bytes = withSamples(
      fields(6),
      Array.from({ length: 6 }, (_, n) => record(n + 1)),
    );
    const file = readable(bytes);
    const full = readSignals(bytes, file, ["Flow.40ms"])._unsafeUnwrap()["Flow.40ms"];
    const part = readSignals(bytes, file, ["Flow.40ms"], { fromRecord: 3, toRecord: 5 });

    expect(part._unsafeUnwrap()["Flow.40ms"]).toEqual(full.subarray(6, 10));
  });

  it("reads records past the header's count", () => {
    const bytes = withSamples(fields(2), [record(1), record(2), record(3)]);
    const leakValues = readSignals(bytes, readable(bytes), ["Leak.2s"])._unsafeUnwrap()["Leak.2s"];

    expect(Array.from(leakValues)).toEqual([
      expect.closeTo(0.02, 10),
      expect.closeTo(0.04, 10),
      expect.closeTo(0.06, 10),
    ]);
  });

  it("reads bytes that start at an odd offset", () => {
    const bytes = withSamples(fields(1), [record(5)]);
    const shifted = new Uint8Array(bytes.length + 1).subarray(1);

    shifted.set(bytes);

    const leakValues = readSignals(shifted, readable(shifted), ["Leak.2s"])._unsafeUnwrap();

    expect(leakValues["Leak.2s"][0]).toBeCloseTo(0.1, 10);
  });

  it.each<[RecordRange]>([
    [{ fromRecord: 2, toRecord: 1 }],
    [{ fromRecord: -1 }],
    [{ toRecord: 4 }],
    [{ fromRecord: 0.5 }],
  ])("rejects the range %j", (range) => {
    const bytes = withSamples(fields(3), [record(1), record(2), record(3)]);

    expect(readSignals(bytes, readable(bytes), ["Flow.40ms"], range)._unsafeUnwrapErr()).toEqual({
      kind: "range_out_of_bounds",
      fromRecord: range.fromRecord ?? 0,
      toRecord: range.toRecord ?? 3,
      records: 3,
    });
  });

  it("names a label the file doesn't have", () => {
    const bytes = withSamples(fields(1), [record(1)]);

    expect(readSignals(bytes, readable(bytes), ["Press.40ms"])._unsafeUnwrapErr()).toEqual({
      kind: "missing_signal",
      label: "Press.40ms",
    });
  });
});
