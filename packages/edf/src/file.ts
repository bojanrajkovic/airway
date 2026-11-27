import { err, ok, type Result } from "neverthrow";
import {
  dataSignals,
  type DataLabel,
  type EdfAnnotationFileType,
  type EdfFileType,
  type EdfSignalFileType,
} from "./airsense.ts";
import { readAnnotations, type EdfAnnotation } from "./annotations.ts";
import { badRecords } from "./checksum.ts";
import {
  EdfFormat,
  isReadable,
  readHeader,
  type EdfFileHeaders,
  type EdfHeader,
  type EdfReadError,
  type EdfSignalHeader,
  type EdfWarning,
} from "./header.ts";
import { readSignals, type EdfSamples } from "./signals.ts";

/** Lists the fields that `readEdf` returns for every file, both signal files and annotation files. */
type EdfFileBase = {
  header: EdfHeader;
  /** Lists the signal headers as the file declares them, in file order. */
  signals: readonly EdfSignalHeader[];
  /**
   * Stores the number of whole records on disk. This number can exceed the number that the header
   * declares.
   */
  records: number;
  /** Lists the 0-based numbers of the records whose Crc16 doesn't match the record's bytes. */
  badRecords: number[];
  warnings: EdfWarning[];
};

/** Describes a whole file that stores samples. `samples` has one array for each data signal. */
export type EdfSignalFile<L extends string> = EdfFileBase & { samples: EdfSamples<L> };

/** Describes a whole file that stores annotations. */
export type EdfAnnotationFile = EdfFileBase & { annotations: EdfAnnotation[] };

/**
 * Resolves to the whole file that `readEdf` returns for the file type `F`. For a signal file
 * type, the file has `samples`, keyed by the type's data labels. For an annotation file type, the
 * file has `annotations`.
 */
export type EdfFile<F extends EdfFileType> = F extends EdfSignalFileType
  ? EdfSignalFile<DataLabel<F>>
  : EdfAnnotationFile;

// Checks a file's headers against `type`. The format and the record length must match, and the
// file must declare every signal that `type` lists. A file may declare signals that `type` doesn't
// list.
function checkType(headers: EdfFileHeaders, type: EdfFileType): Result<void, EdfReadError> {
  const { format, recordSeconds } = headers.header;

  if (format !== type.header.format) {
    return err({ kind: "format_mismatch", expected: type.header.format, got: format });
  }

  if (recordSeconds !== type.header.recordSeconds) {
    return err({
      kind: "record_length_mismatch",
      expected: type.header.recordSeconds,
      got: recordSeconds,
    });
  }

  const labels = new Set(headers.signals.map((signal) => signal.label));
  const missing = type.signals.find((signal) => !labels.has(signal.label));

  return missing === undefined
    ? ok(undefined)
    : err({ kind: "missing_signal", label: missing.label });
}

/**
 * Reads one whole file of the kind that `type` describes: its main header, its signal headers,
 * and its samples or annotations. `bytes` must hold the whole file.
 *
 * Returns an error when the file's format or record length differs from `type`, when the file
 * lacks one of the signals that `type` lists, or when `checkFileSize` rejects the file. `readEdf`
 * reads a file that holds only a header as a file with no records.
 */
export function readEdf<F extends EdfSignalFileType>(
  bytes: Uint8Array,
  type: F,
): Result<EdfFile<F>, EdfReadError>;
export function readEdf<F extends EdfAnnotationFileType>(
  bytes: Uint8Array,
  type: F,
): Result<EdfFile<F>, EdfReadError>;
export function readEdf(
  bytes: Uint8Array,
  type: EdfFileType,
): Result<EdfSignalFile<string> | EdfAnnotationFile, EdfReadError>;
export function readEdf(
  bytes: Uint8Array,
  type: EdfFileType,
): Result<EdfSignalFile<string> | EdfAnnotationFile, EdfReadError> {
  return readHeader(bytes).andThen((headers) =>
    checkType(headers, type).andThen(() => {
      const { header, signals, size, warnings } = headers;

      if (size.verdict === "reject") {
        return err({ kind: "size_rejected" as const, reason: size.reason });
      }

      const base: EdfFileBase = {
        header,
        signals,
        records: size.records,
        badRecords: badRecords(bytes, headers),
        warnings,
      };

      if (type.header.format === EdfFormat.EdfPlusD) {
        // Skips parsing for a file that holds only a header.
        return (isReadable(headers) ? readAnnotations(bytes, headers) : ok([])).map(
          (annotations) => ({ ...base, annotations }),
        );
      }

      const labels = dataSignals(type).map((signal) => signal.label);
      const samples = isReadable(headers)
        ? readSignals(bytes, headers, labels)
        : ok(Object.fromEntries(labels.map((label) => [label, new Float64Array()])));

      return samples.map((values) => ({ ...base, samples: values }));
    }),
  );
}
