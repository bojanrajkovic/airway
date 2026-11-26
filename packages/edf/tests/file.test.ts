import { describe, expect, it } from "vitest";
import type { EdfAnnotationFileType, EdfSignalFileType } from "../src/airsense.ts";
import type { EdfSignalHeader } from "../src/header.ts";
import { readEdf } from "../src/file.ts";
import { annotated, crc16, file, flow, plain, withSamples, withTals } from "./bytes.ts";

// These types declare what plain() and annotated() write. readEdf checks only the format, the
// record length, and the labels, so each signal's ranges are left at placeholder values.
const signal = <const L extends string>(
  label: L,
  samplesPerRecord: number,
): EdfSignalHeader<L> => ({
  label,
  unit: "",
  physicalMin: "0",
  physicalMax: "1",
  digitalMin: 0,
  digitalMax: 1,
  samplesPerRecord,
});
const flowFile = {
  header: { format: "EDF", recordSeconds: 60 },
  signals: [signal("Flow.40ms", 2), signal("Crc16", 1)],
} satisfies EdfSignalFileType;
const annotationFile = {
  header: { format: "EDF+D", recordSeconds: 0 },
  signals: [signal("EDF Annotations", 32), signal("Crc16", 1)],
} satisfies EdfAnnotationFileType;

const TIMEKEEPING = "+0\x14\x14\0";

describe("readEdf", () => {
  it("reads a signal file's headers and every data signal's samples", () => {
    const bytes = withSamples(plain(), [
      [1, -50, 0],
      [32767, -32768, 0],
    ]);
    const read = readEdf(bytes, flowFile)._unsafeUnwrap();

    expect(read.header).toMatchObject({ format: "EDF", recordSeconds: 60, declaredRecords: 2 });
    expect(read.signals.map(({ label }) => label)).toEqual(["Flow.40ms", "Crc16"]);
    expect(read.records).toBe(2);
    expect(read.warnings).toEqual([]);
    expect(Object.keys(read.samples)).toEqual(["Flow.40ms"]);
    // The file's own header gives the scale: -655.36 + (digital + 32768) × 0.02.
    expect(Array.from(read.samples["Flow.40ms"])).toEqual([
      expect.closeTo(0.02, 10),
      expect.closeTo(-1, 10),
      expect.closeTo(655.34, 10),
      expect.closeTo(-655.36, 10),
    ]);
  });

  it("reads a file that declares a signal that the file type doesn't list", () => {
    const fields = plain({
      records: "1",
      signals: [flow, { ...flow, label: "Press.40ms" }, crc16],
    });
    const read = readEdf(withSamples(fields, [[1, -50, 7, 8, 0]]), flowFile)._unsafeUnwrap();

    expect(read.signals).toHaveLength(3);
    expect(Object.keys(read.samples)).toEqual(["Flow.40ms"]);
    expect(read.samples["Flow.40ms"]).toHaveLength(2);
  });

  it("reads an annotation file's annotations", () => {
    const bytes = withTals(annotated(1), [`${TIMEKEEPING}+10\x1530\x14Hypopnea\x14\0`]);
    const read = readEdf(bytes, annotationFile)._unsafeUnwrap();

    expect(read.records).toBe(1);
    expect(read.annotations).toEqual([{ onset: 10, duration: 30, label: "Hypopnea" }]);
  });

  it("reads a file that holds only a header as a file with no records", () => {
    const signals = readEdf(file(plain({ records: "0" }), 0), flowFile)._unsafeUnwrap();
    const annotations = readEdf(file(annotated(0), 0), annotationFile)._unsafeUnwrap();

    expect(signals.records).toBe(0);
    expect(signals.samples["Flow.40ms"]).toHaveLength(0);
    expect(annotations.annotations).toEqual([]);
  });

  it("rejects a file whose format differs from the file type's", () => {
    const bytes = withSamples(plain(), [[1, 2, 0]]);

    expect(readEdf(bytes, annotationFile)._unsafeUnwrapErr()).toEqual({
      kind: "format_mismatch",
      expected: "EDF+D",
      got: "EDF",
    });
  });

  it("rejects a file whose record length differs from the file type's", () => {
    const bytes = withSamples(plain({ recordSeconds: "30.00" }), [[1, 2, 0]]);

    expect(readEdf(bytes, flowFile)._unsafeUnwrapErr()).toEqual({
      kind: "record_length_mismatch",
      expected: 60,
      got: 30,
    });
  });

  it("rejects a file that lacks one of the file type's signals", () => {
    const bytes = withSamples(plain({ signals: [{ ...flow, label: "Press.40ms" }, crc16] }), [
      [1, 2, 0],
    ]);

    expect(readEdf(bytes, flowFile)._unsafeUnwrapErr()).toEqual({
      kind: "missing_signal",
      label: "Flow.40ms",
    });
  });

  it("rejects a file that ends partway through a record", () => {
    expect(readEdf(file(plain(), 9), flowFile)._unsafeUnwrapErr()).toEqual({
      kind: "size_rejected",
      reason: "truncated",
    });
  });
});
