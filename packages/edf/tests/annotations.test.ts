import { describe, expect, it } from "vitest";
import type { Result } from "neverthrow";
import { readAnnotations, type EdfAnnotation } from "../src/annotations.ts";
import { isReadable, readHeader, type EdfReadError } from "../src/header.ts";
import { readable } from "./readable.ts";
import { annotated, file, plain, withTals } from "./bytes.ts";

const TIMEKEEPING = "+0\x14\x14\0";

const read = (
  records: string[],
  declared = records.length,
): Result<EdfAnnotation[], EdfReadError> => {
  const bytes = withTals(annotated(declared), records);

  return readAnnotations(bytes, readable(bytes));
};

describe("readAnnotations", () => {
  it("reads every text of every TAL in a record, and drops timekeeping TALs", () => {
    const annotations = read([
      `${TIMEKEEPING}+10\x1530\x14Hypopnea\x14\0+50\x14Arousal\x14Apnea\x14\0`,
    ]);

    expect(annotations._unsafeUnwrap()).toEqual([
      { onset: 10, duration: 30, label: "Hypopnea" },
      { onset: 50, duration: 0, label: "Arousal" },
      { onset: 50, duration: 0, label: "Apnea" },
    ]);
  });

  it("keeps an annotation at onset 0", () => {
    expect(read([`${TIMEKEEPING}+0\x14Recording starts\x14\0`])._unsafeUnwrap()).toEqual([
      { onset: 0, duration: 0, label: "Recording starts" },
    ]);
  });

  it("reads decimal onsets, and reads an empty duration as 0", () => {
    expect(read(["+5.5\x15\x14Apnea\x14\0"])._unsafeUnwrap()).toEqual([
      { onset: 5.5, duration: 0, label: "Apnea" },
    ]);
  });

  it("decodes labels as UTF-8", () => {
    expect(read(["+1\x14Événement\x14\0"])._unsafeUnwrap()).toEqual([
      { onset: 1, duration: 0, label: "Événement" },
    ]);
  });

  it("skips each record's Crc16 and reads records past the header's count", () => {
    const records = [
      `${TIMEKEEPING}+1\x1510\x14Apnea\x14\0`,
      `${TIMEKEEPING}+90\x1512\x14Hypopnea\x14\0`,
    ];

    expect(read(records, 1)._unsafeUnwrap()).toEqual([
      { onset: 1, duration: 10, label: "Apnea" },
      { onset: 90, duration: 12, label: "Hypopnea" },
    ]);
  });

  it("reports which record holds a malformed TAL", () => {
    expect(read([`${TIMEKEEPING}+1\x14Apnea\x14\0`, "Apnea\x14\0"])._unsafeUnwrapErr()).toEqual({
      kind: "bad_annotation",
      record: 1,
      tal: "Apnea\x14",
    });
  });

  it("rejects bytes that hold only the header", () => {
    const bytes = withTals(annotated(1), [`${TIMEKEEPING}+1\x14Apnea\x14\0`]);
    const head = bytes.subarray(0, 768);
    const parsed = readHeader(head, bytes.length)._unsafeUnwrap();

    if (!isReadable(parsed)) {
      throw new Error("expected a readable file");
    }

    expect(readAnnotations(head, parsed)._unsafeUnwrapErr()).toMatchObject({
      kind: "bytes_too_short",
    });
  });

  it("rejects a file with no annotation signal", () => {
    const bytes = file(plain(), 12);

    expect(readAnnotations(bytes, readable(bytes))._unsafeUnwrapErr()).toEqual({
      kind: "no_annotations",
    });
  });
});
