import { describe, expect, it } from "vitest";
import { isReadable, readHeader, type EdfReadError } from "../src/header.ts";
import type { FileSizeCheck } from "../src/size.ts";
import { crc16, file, flow, header, plain } from "./bytes.ts";

// plain() has a 768-byte header and 6-byte records: two Flow samples and a Crc16.
const RECORD = 6;

const check = (records: string, bodyBytes: number): FileSizeCheck | EdfReadError =>
  readHeader(file(plain({ records }), bodyBytes)).match(
    ({ size }) => size,
    (error) => error,
  );

describe("readHeader", () => {
  it("parses the header's fields", () => {
    const parsed = readHeader(file(plain(), 2 * RECORD))._unsafeUnwrap();

    expect(parsed.header).toEqual({
      format: "EDF",
      start: Temporal.PlainDateTime.from("2030-01-07T21:15:04"),
      patient: "X X X X",
      recording: "Startdate 07-JAN-2030 X X X",
      headerBytes: 768,
      declaredRecords: 2,
      recordSeconds: 60,
      signals: [
        {
          label: "Flow.40ms",
          unit: "L/s",
          physicalMin: "-655.36",
          physicalMax: "655.34",
          digitalMin: -32768,
          digitalMax: 32767,
          samplesPerRecord: 2,
        },
        {
          label: "Crc16",
          unit: "",
          physicalMin: "-32768",
          physicalMax: "32767",
          digitalMin: -32768,
          digitalMax: 32767,
          samplesPerRecord: 1,
        },
      ],
    });
    expect(parsed.warnings).toEqual([]);
  });

  it.each<[string, string, number, FileSizeCheck]>([
    ["matches its header", "2", 2 * RECORD, { verdict: "read", header: "matches", records: 2 }],
    [
      "is header-only with a -1 count",
      "-1",
      0,
      { verdict: "skip", header: "unknown_length", records: 0 },
    ],
    [
      "holds one record more than declared",
      "2",
      3 * RECORD,
      { verdict: "read", header: "undercounted", records: 3 },
    ],
    ["is truncated", "3", 2 * RECORD, { verdict: "reject", reason: "truncated" }],
    [
      "ends in a partial record",
      "2",
      2 * RECORD + 1,
      { verdict: "reject", reason: "partial_record" },
    ],
  ])("gives checkFileSize the right numbers when a file %s", (_, records, bodyBytes, expected) => {
    expect(check(records, bodyBytes)).toEqual(expected);
  });

  it("checks the size on disk when given only the header's bytes", () => {
    const head = header(plain());
    const parsed = readHeader(head, head.length + 3 * RECORD)._unsafeUnwrap();

    expect(parsed.size).toEqual({ verdict: "read", header: "undercounted", records: 3 });
  });

  it("asks for more bytes when they end before the header does", () => {
    const head = header(plain());

    expect(readHeader(head.subarray(0, 100))._unsafeUnwrapErr()).toEqual({
      kind: "header_too_short",
      headerBytes: 256,
    });
    expect(readHeader(head.subarray(0, 256), 10_000)._unsafeUnwrapErr()).toEqual({
      kind: "header_too_short",
      headerBytes: 768,
    });
  });

  it.each([
    ["84", 2084],
    ["85", 1985],
    ["99", 1999],
    ["00", 2000],
  ])("reads the two-digit year %s as %i", (yy, year) => {
    const fields = plain({ startDate: `07.01.${yy}`, recording: "" });

    expect(readHeader(file(fields, 0))._unsafeUnwrap().header.start.year).toBe(year);
  });

  it("warns when the recording field's Startdate differs from the start date", () => {
    const fields = plain({ recording: "Startdate 08-JAN-2030 X X X" });

    expect(readHeader(file(fields, 0))._unsafeUnwrap().warnings).toEqual([
      {
        kind: "startdate_mismatch",
        header: Temporal.PlainDate.from("2030-01-07"),
        startdate: Temporal.PlainDate.from("2030-01-08"),
      },
    ]);
  });

  it.each(["", "Startdate X X X", "Startdate 31-FEB-2030 X"])(
    "doesn't warn when the recording field is %j",
    (recording) => {
      expect(readHeader(file(plain({ recording }), 0))._unsafeUnwrap().warnings).toEqual([]);
    },
  );

  it.each<[string, Parameters<typeof plain>[0], EdfReadError]>([
    [
      "an unknown format",
      { reserved: "EDF+X" },
      { kind: "bad_field", field: "reserved", value: "EDF+X" },
    ],
    [
      "a non-numeric count",
      { records: "lots" },
      { kind: "bad_field", field: "records", value: "lots" },
    ],
    [
      "a negative count other than -1",
      { records: "-2" },
      { kind: "bad_field", field: "records", value: "-2" },
    ],
    [
      "a negative record duration",
      { recordSeconds: "-60" },
      { kind: "bad_field", field: "record duration", value: "-60" },
    ],
    [
      "an impossible date",
      { startDate: "31.02.30" },
      { kind: "bad_field", field: "start", value: "31.02.30 21.15.04" },
    ],
    [
      "a header length that doesn't fit the signals",
      { headerBytes: "1024" },
      { kind: "bad_field", field: "header bytes", value: "1024" },
    ],
    [
      "an empty digital range",
      { signals: [{ ...flow, digitalMax: "-32768" }, crc16] },
      { kind: "bad_field", field: "Flow.40ms digital range", value: "-32768 to -32768" },
    ],
  ])("rejects %s", (_, overrides, error) => {
    expect(readHeader(file(plain(overrides), 0))._unsafeUnwrapErr()).toEqual(error);
  });

  it("reads a blank reserved field as plain EDF", () => {
    expect(readHeader(file(plain({ reserved: "" }), 0))._unsafeUnwrap().header.format).toBe("EDF");
  });

  it("narrows to a readable file only when the verdict is read", () => {
    const read = readHeader(file(plain(), 2 * RECORD))._unsafeUnwrap();
    const skipped = readHeader(file(plain({ records: "-1" }), 0))._unsafeUnwrap();

    expect([isReadable(read), isReadable(skipped)]).toEqual([true, false]);
  });
});
