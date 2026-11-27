// Checks the card's two kinds of checksum: the Crc16 that ends each data record, and the .crc file
// beside Identification.tgt and some night files.
import { crc32 } from "node:zlib";
import crc16ccitt from "crc/calculators/crc16ccitt";
import { FileChecksum } from "@airway/contract/derived/values";
import { FIXED_BYTES, isReadable, recordBytes, type EdfFileHeaders } from "./header.ts";

/**
 * Returns the 0-based numbers of the records whose Crc16 sample differs from the
 * CRC-16/CCITT-FALSE of the record's other bytes. Each record stores its Crc16 in its last 2
 * bytes, little-endian. Returns an empty list unless `checkFileSize` returned the `read` verdict.
 */
export function badRecords(bytes: Uint8Array, headers: EdfFileHeaders): number[] {
  if (!isReadable(headers)) {
    return [];
  }

  const size = recordBytes(headers);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad: number[] = [];

  for (let record = 0; record < headers.size.records; record++) {
    const start = headers.header.headerBytes + record * size;
    const end = start + size - 2;

    if (crc16ccitt(bytes.subarray(start, end)) !== view.getUint16(end, true)) {
      bad.push(record);
    }
  }

  return bad;
}

/** Resolves to the outcome of comparing a file with its `.crc` file. */
export type CompanionCheck = Exclude<FileChecksum, FileChecksum.Unchecked>;

/**
 * Compares `bytes` with `crc`, the contents of the file's `.crc` file. The `.crc` holds
 * little-endian CRC-32s, and its length sets the format:
 *
 * - 8 bytes: one CRC-32 of the first 256 bytes and one of the rest, as in a night file's `.crc`.
 * - 4 bytes: one CRC-32 of the whole file, as in Identification.crc.
 *
 * Returns `mismatch` for a `.crc` of any other length.
 */
export function checkCompanion(bytes: Uint8Array, crc: Uint8Array): CompanionCheck {
  const view = new DataView(crc.buffer, crc.byteOffset, crc.byteLength);
  const matches =
    crc.length === 8
      ? view.getUint32(0, true) === crc32(bytes.subarray(0, FIXED_BYTES)) &&
        view.getUint32(4, true) === crc32(bytes.subarray(FIXED_BYTES))
      : crc.length === 4 && view.getUint32(0, true) === crc32(bytes);

  return matches ? FileChecksum.Match : FileChecksum.Mismatch;
}
