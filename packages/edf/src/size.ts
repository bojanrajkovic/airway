/** What a file's header says about its size, and the size on disk. */
export type FileSizeInputs = {
  size: number;
  headerBytes: number;
  recordBytes: number;
  /** The header's record count: -1, EDF's "unknown", when the card never filled it in. */
  declaredRecords: number;
};

/** How a header's record count compares with the whole records on disk. */
export type HeaderCount = "matches" | "unknown_length" | "undercounted";

/**
 * What ingest does with a file, from its size against its header.
 *
 * - `read`: at least one whole record. `records` counts every whole record on disk, and `header`
 *   says how the header's count compares, so a scan can report files by it.
 * - `skip`: a header with no records.
 * - `reject`: the file is `truncated` (fewer records than declared) or ends in a
 *   `partial_record`, so it was cut off or is still being written. Its night imports without it.
 */
export type FileSizeCheck =
  | { verdict: "read"; header: HeaderCount; records: number }
  | { verdict: "skip"; header: Exclude<HeaderCount, "undercounted">; records: 0 }
  | { verdict: "reject"; reason: "truncated" | "partial_record" };

/** Checks a file's size against its header. `truncated` wins over `partial_record`. */
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
