/** Combines the size fields from a file's header with the file's size on disk. */
export type FileSizeInputs = {
  size: number;
  headerBytes: number;
  recordBytes: number;
  /**
   * The header declares this many records, or -1 when the card never filled in the count. EDF
   * defines -1 as unknown.
   */
  declaredRecords: number;
};

/**
 * Says whether the header's record count is unknown, equal to the number of whole records on disk,
 * or lower than that number.
 */
export type HeaderCount = "matches" | "unknown_length" | "undercounted";

/**
 * Tells ingest whether to read, skip, or reject a file, based on the file's size and header.
 *
 * - `read`: the file has at least one whole record. `records` is the number of whole records on
 *   disk. `header` compares the header's record count with `records`, so a scan can report
 *   files by `header`.
 * - `skip`: the file contains only a header.
 * - `reject`: the file has fewer whole records than its header declares (`truncated`) or ends
 *   partway through a record (`partial_record`). Either the file was cut off or it's still being
 *   written. Ingest imports the night without this file.
 */
export type FileSizeCheck =
  | { verdict: "read"; header: HeaderCount; records: number }
  | { verdict: "skip"; header: Exclude<HeaderCount, "undercounted">; records: 0 }
  | { verdict: "reject"; reason: "truncated" | "partial_record" };

/**
 * Checks a file's size against its header. Rejects a file as `truncated` when it is short of
 * records and also ends in a partial record.
 */
export function checkFileSize({
  size,
  headerBytes,
  recordBytes,
  declaredRecords,
}: FileSizeInputs): FileSizeCheck {
  const body = size - headerBytes;
  const records = Math.floor(body / recordBytes);
  const unknown = declaredRecords === -1;

  if (body < 0 || (!unknown && records < declaredRecords)) {
    return { verdict: "reject", reason: "truncated" };
  }

  if (body % recordBytes !== 0) {
    return { verdict: "reject", reason: "partial_record" };
  }

  if (records === 0) {
    return { verdict: "skip", header: unknown ? "unknown_length" : "matches", records: 0 };
  }

  return {
    verdict: "read",
    header: unknown ? "unknown_length" : records > declaredRecords ? "undercounted" : "matches",
    records,
  };
}
