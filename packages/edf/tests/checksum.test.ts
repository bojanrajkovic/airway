import { crc32 } from "node:zlib";
import crc16ccitt from "crc/calculators/crc16ccitt";
import { describe, expect, it } from "vitest";
import { FileChecksum } from "@airway/contract/derived/values";
import { badRecords, checkCompanion } from "../src/checksum.ts";
import { readHeader, type EdfFileHeaders } from "../src/header.ts";
import { file, plain, withSamples } from "./bytes.ts";

// plain() records hold two Flow samples and a Crc16, so each record is 6 bytes.
const RECORD_BYTES = 6;

// Sets each record's Crc16 to the CRC of the record's first 4 bytes, as the card does.
function signed(records: number[][]): Uint8Array {
  const bytes = withSamples(plain({ records: records.length.toString() }), records);
  const view = new DataView(bytes.buffer);
  const first = bytes.length - RECORD_BYTES * records.length;

  for (let start = first; start < bytes.length; start += RECORD_BYTES) {
    view.setUint16(start + 4, crc16ccitt(bytes.subarray(start, start + 4)), true);
  }

  return bytes;
}

const headersOf = (bytes: Uint8Array): EdfFileHeaders => readHeader(bytes)._unsafeUnwrap();

describe("badRecords", () => {
  it("returns an empty list when every Crc16 matches", () => {
    const bytes = signed([
      [1, 2, 0],
      [3, 4, 0],
      [5, 6, 0],
    ]);

    expect(badRecords(bytes, headersOf(bytes))).toEqual([]);
  });

  it("reports the number of each record whose bytes changed after its Crc16 was written", () => {
    const bytes = signed([
      [1, 2, 0],
      [3, 4, 0],
      [5, 6, 0],
    ]);
    const first = bytes.length - RECORD_BYTES * 3;

    bytes[first + RECORD_BYTES + 1] = (bytes[first + RECORD_BYTES + 1] ?? 0) ^ 0x10;

    expect(badRecords(bytes, headersOf(bytes))).toEqual([1]);
  });

  it("reports a record whose Crc16 is zero", () => {
    const bytes = withSamples(plain({ records: "1" }), [[1, 2, 0]]);

    expect(badRecords(bytes, headersOf(bytes))).toEqual([0]);
  });

  it("returns an empty list for a header-only file", () => {
    const bytes = file(plain({ records: "0" }), 0);

    expect(badRecords(bytes, headersOf(bytes))).toEqual([]);
  });
});

// Returns `values` as little-endian uint32s.
function littleEndian(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(4 * values.length);
  const view = new DataView(bytes.buffer);

  values.forEach((value, i) => {
    view.setUint32(4 * i, value, true);
  });

  return bytes;
}

describe("checkCompanion", () => {
  const edf = signed([
    [1, 2, 0],
    [3, 4, 0],
  ]);
  const nightCrc = littleEndian(crc32(edf.subarray(0, 256)), crc32(edf.subarray(256)));

  it("matches a night file with its two CRC-32s, one over the first 256 bytes and one over the rest", () => {
    expect(checkCompanion(edf, nightCrc)).toBe(FileChecksum.Match);
  });

  it.each([
    ["the first 256 bytes", 10],
    ["the rest of the file", 770],
  ])("reports a mismatch after one byte of %s changes", (_, offset) => {
    const changed = edf.slice();

    changed[offset] = (changed[offset] ?? 0) ^ 0x01;

    expect(checkCompanion(changed, nightCrc)).toBe(FileChecksum.Mismatch);
  });

  it("matches a .crc that holds one CRC-32 of the whole file, as Identification.crc does", () => {
    const tgt = new TextEncoder().encode("#SRN 00000000000\n#PNA AirSense_11\n");

    expect(checkCompanion(tgt, littleEndian(crc32(tgt)))).toBe(FileChecksum.Match);
    expect(checkCompanion(tgt, littleEndian(crc32(tgt) ^ 1))).toBe(FileChecksum.Mismatch);
  });

  it.each([0, 3, 12])("reports a mismatch for a %i-byte .crc", (length) => {
    expect(checkCompanion(edf, new Uint8Array(length))).toBe(FileChecksum.Mismatch);
  });
});
