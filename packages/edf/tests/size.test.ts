import { describe, expect, it } from "vitest";
import { checkFileSize, type FileSizeCheck } from "../src/size.ts";

// Checks a file that has a 768-byte header and 40-byte records.
const file = (size: number, declaredRecords: number): FileSizeCheck =>
  checkFileSize({ size, headerBytes: 768, recordBytes: 40, declaredRecords });

describe("checkFileSize", () => {
  it.each<[string, number, number, FileSizeCheck]>([
    [
      "has as many records as its header declares",
      768 + 3 * 40,
      3,
      { verdict: "read", header: "matches", records: 3 },
    ],
    [
      "declares -1 records and ends on a whole record",
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
      "contains only a header and declares -1 records",
      768,
      -1,
      { verdict: "skip", header: "unknown_length", records: 0 },
    ],
    [
      "contains only a header and declares 0 records",
      768,
      0,
      { verdict: "skip", header: "matches", records: 0 },
    ],
    [
      "holds fewer records than it declares",
      768 + 2 * 40,
      3,
      { verdict: "reject", reason: "truncated" },
    ],
    [
      "holds fewer records than it declares and ends mid-record",
      768 + 2 * 40 + 7,
      3,
      { verdict: "reject", reason: "truncated" },
    ],
    [
      "ends mid-record after the records that it declares",
      768 + 3 * 40 + 7,
      3,
      { verdict: "reject", reason: "partial_record" },
    ],
    [
      "declares -1 records and ends mid-record",
      768 + 40 + 7,
      -1,
      { verdict: "reject", reason: "partial_record" },
    ],
    ["is smaller than its header", 500, -1, { verdict: "reject", reason: "truncated" }],
  ])("a file that %s", (_, size, declared, expected) => {
    expect(file(size, declared)).toEqual(expected);
  });
});
