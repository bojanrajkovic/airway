import { err, ok, Result } from "neverthrow";
import { coversRecords, recordBytes, type EdfReadError, type ReadableEdfFile } from "./header.ts";

/** One EDF+ annotation, with times in seconds from the file's start. */
export type Annotation = { onset: number; duration: number; label: string };

const ANNOTATION_LABEL = "EDF Annotations";
// A TAL: a signed onset, an optional duration after \x15, then texts each ended by \x14.
// oxlint-disable-next-line eslint/no-control-regex -- EDF+ separates a TAL's parts with \x14 and \x15
const TAL = /^([+\-]\d+(?:\.\d+)?)(?:\x15(\d+(?:\.\d+)?)?)?\x14(.*)$/sv;
const decoder = new TextDecoder();

// Splits one record's annotation bytes into TALs, which EDF+ ends with a zero byte.
function tals(chunk: Uint8Array): string[] {
  const found: string[] = [];
  let start = 0;

  for (let i = 0; i <= chunk.length; i += 1) {
    if (i === chunk.length || chunk[i] === 0) {
      if (i > start) {
        found.push(decoder.decode(chunk.subarray(start, i)));
      }

      start = i + 1;
    }
  }

  return found;
}

function parseTal(record: number, tal: string): Result<Annotation[], EdfReadError> {
  const match = TAL.exec(tal);

  if (match === null) {
    return err({ kind: "bad_annotation", record, tal });
  }

  const onset = Number(match[1]);
  // An absent or empty duration reads as 0.
  const duration = Number(match[2] ?? 0);
  const labels = (match[3] ?? "").split("\x14").filter((text) => text !== "");

  // A TAL with no text is a timekeeping TAL, which only marks the record's start.
  return ok(labels.map((label) => ({ onset, duration, label })));
}

/**
 * Reads every annotation in an EDF+ file, in record order. Onsets and durations are seconds from
 * the file's start, and labels come back as written. Timekeeping TALs are dropped. Reads every
 * whole record on disk, including records past the header's count.
 */
export function readAnnotations(
  bytes: Uint8Array,
  file: ReadableEdfFile,
): Result<Annotation[], EdfReadError> {
  const { header } = file;
  const stride = recordBytes(header);
  let offset = 0;
  const spans: { offset: number; length: number }[] = [];

  for (const signal of header.signals) {
    if (signal.label === ANNOTATION_LABEL) {
      spans.push({ offset, length: 2 * signal.samplesPerRecord });
    }

    offset += 2 * signal.samplesPerRecord;
  }

  if (spans.length === 0) {
    return err({ kind: "no_annotations" });
  }

  const covered = coversRecords(bytes, header, file.size.records);

  if (covered.isErr()) {
    return err(covered.error);
  }

  const parsed: Result<Annotation[], EdfReadError>[] = [];

  for (let record = 0; record < file.size.records; record += 1) {
    const base = header.headerBytes + record * stride;

    for (const span of spans) {
      const chunk = bytes.subarray(base + span.offset, base + span.offset + span.length);

      parsed.push(...tals(chunk).map((tal) => parseTal(record, tal)));
    }
  }

  return Result.combine(parsed).map((lists) => lists.flat());
}
