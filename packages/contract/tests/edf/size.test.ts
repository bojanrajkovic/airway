import { describe, expect, it } from "vitest";
import { checkFileSize, type FileSizeCheck } from "../../src/edf/size.ts";

// A file with a 768-byte header and 40-byte records.
const file = (size: number, declaredRecords: number): FileSizeCheck =>
  checkFileSize({ size, headerBytes: 768, recordBytes: 40, declaredRecords });

describe("checkFileSize", () => {
  it.each<[string, number, number, FileSizeCheck]>([
    ["matches its header", 768 + 3 * 40, 3, { verdict: "read", header: "matches", records: 3 }],
    [
      "has a -1 count and whole records",
      768 + 2 * 40,
      -1,
      { verdict: "read", header: "unknown_length", records: 2 },
    ],
    [
      "holds more records than it declares",
      768 + 4 * 40,
      3,
      { verdict: "read", header: "undercounted", records: 4 },
    ],
    [
      "is a header with a -1 count",
      768,
      -1,
      { verdict: "skip", header: "unknown_length", records: 0 },
    ],
    ["is a header declaring 0 records", 768, 0, { verdict: "skip", header: "matches", records: 0 }],
    [
      "holds fewer records than it declares",
      768 + 2 * 40,
      3,
      { verdict: "reject", reason: "truncated" },
    ],
    [
      "is short and ends mid-record",
      768 + 2 * 40 + 7,
      3,
      { verdict: "reject", reason: "truncated" },
    ],
    [
      "ends mid-record past its declared count",
      768 + 3 * 40 + 7,
      3,
      { verdict: "reject", reason: "partial_record" },
    ],
    [
      "has a -1 count and ends mid-record",
      768 + 40 + 7,
      -1,
      { verdict: "reject", reason: "partial_record" },
    ],
    ["is smaller than its header", 500, -1, { verdict: "reject", reason: "truncated" }],
  ])("a file that %s", (_, size, declared, expected) => {
    expect(file(size, declared)).toEqual(expected);
  });
});
