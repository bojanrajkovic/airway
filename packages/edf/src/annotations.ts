import { err, ok, Result } from "neverthrow";
import {
  coversRecords,
  recordBytes,
  type EdfReadError,
  type ReadableEdfFileHeaders,
} from "./header.ts";

/**
 * Describes one EDF+ annotation. `onset` counts seconds from the file's start, and `duration` is
 * in seconds.
 */
export type EdfAnnotation = { onset: number; duration: number; label: string };

const ANNOTATION_LABEL = "EDF Annotations";
// Matches a TAL (time-stamped annotation list): a signed onset, an optional duration after \x15,
// then texts that each end with \x14.
// oxlint-disable-next-line eslint/no-control-regex -- EDF+ separates a TAL's parts with \x14 and \x15
const TAL = /^([+\-]\d+(?:\.\d+)?)(?:\x15(\d+(?:\.\d+)?)?)?\x14(.*)$/sv;
const decoder = new TextDecoder();

// Splits one record's annotation bytes into TALs. EDF+ ends each TAL with a zero byte.
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

function parseTal(record: number, tal: string): Result<EdfAnnotation[], EdfReadError> {
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
 * Reads every annotation in an EDF+ file, in record order. Each onset counts seconds from the
 * file's start, each duration is in seconds, and labels come back as written. Skips the timekeeping
 * annotations that mark each record's start. Reads every whole record on disk, including records
 * past the header's count.
 */
export function readAnnotations(
  bytes: Uint8Array,
  file: ReadableEdfFileHeaders,
): Result<EdfAnnotation[], EdfReadError> {
  const { header } = file;
  const stride = recordBytes(file);
  let offset = 0;
  const spans: { offset: number; length: number }[] = [];

  for (const signal of file.signals) {
    if (signal.label === ANNOTATION_LABEL) {
      spans.push({ offset, length: 2 * signal.samplesPerRecord });
    }

    offset += 2 * signal.samplesPerRecord;
  }

  const found: Result<typeof spans, EdfReadError> =
    spans.length === 0 ? err({ kind: "no_annotations" }) : ok(spans);

  return found
    .andThen((annotationSpans) =>
      coversRecords(bytes, file, file.size.records).map(() => annotationSpans),
    )
    .andThen((annotationSpans) => {
      const parsed: Result<EdfAnnotation[], EdfReadError>[] = [];

      for (let record = 0; record < file.size.records; record += 1) {
        const base = header.headerBytes + record * stride;

        for (const span of annotationSpans) {
          const chunk = bytes.subarray(base + span.offset, base + span.offset + span.length);

          parsed.push(...tals(chunk).map((tal) => parseTal(record, tal)));
        }
      }

      return Result.combine(parsed).map((lists) => lists.flat());
    });
}
