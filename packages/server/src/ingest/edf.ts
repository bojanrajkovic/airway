// Reads EDF files from the CPAP data folder and runs each read in its own span. @airway/edf
// parses the bytes.
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Attributes, Span } from "@opentelemetry/api";
import { errAsync, okAsync, ResultAsync, type Result } from "neverthrow";
import type { FileRow } from "@airway/contract/derived/rows";
import { FileChecksum } from "@airway/contract/derived/values";
import type { EdfAnnotationFileType, EdfFileType, EdfSignalFileType } from "@airway/edf/airsense";
import { checkCompanion } from "@airway/edf/checksum";
import {
  readEdf,
  type EdfAnnotationFile,
  type EdfFile,
  type EdfSignalFile,
} from "@airway/edf/file";
import {
  FIXED_BYTES,
  readHeader,
  type EdfFileHeaders,
  type EdfReadError,
  type EdfWarning,
} from "@airway/edf/header";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { isNotFound, readCpapFile, readFailed, type ReadFailed } from "./read.ts";

/**
 * Reports why a file in the CPAP data folder couldn't be read or parsed. `path` is the file's path
 * relative to the CPAP data folder.
 */
export type EdfFileError = (EdfReadError & { path: string }) | ReadFailed;

// Adds the file's path to an error, because readEdf and readHeader parse bytes and don't know the
// path.
const withPath =
  (path: string) =>
  (error: EdfReadError): EdfFileError => ({ ...error, path });

// Returns a header warning's kind and details as span event attributes. The build fails here when
// a new warning kind has different fields.
function warningAttributes({ kind, headerDate, startdate }: EdfWarning): Attributes {
  return {
    "edf.warning.kind": kind,
    "edf.warning.header_date": headerDate.toString(),
    "edf.warning.startdate": startdate.toString(),
  };
}

// Adds an `edf.warning` span event and a warn log for each header warning.
function reportWarnings(span: Span, logger: Logger, warnings: readonly EdfWarning[]): void {
  span.setAttribute("edf.warning_count", warnings.length);

  for (const warning of warnings) {
    span.addEvent("edf.warning", warningAttributes(warning));
    logger.warn({ warning }, "EDF header warning");
  }
}

/**
 * Reads only the header of the EDF file at `path` and checks the file's size against it, in an
 * `edf.read_header` span. `path` is relative to the CPAP data folder. The function reads the
 * first 256 bytes, which include the header's length, and then reads the rest of the header. The
 * span records the path, the format, the size verdict, the number of whole records on disk, and
 * the warning count. The function adds an `edf.warning` span event for each header warning and
 * logs the warning at `warn`.
 */
export function readEdfHeader(
  ctx: Pick<AppContext, "config" | "logger">,
  path: string,
): ResultAsync<EdfFileHeaders, EdfFileError> {
  const logger = ctx.logger.child({ module: "ingest.edf", path });

  return inSpanAsync("edf.read_header", (span) => {
    span.setAttribute("airway.file.path", path);

    return ResultAsync.fromPromise(open(join(ctx.config.cpapDataPath, path), "r"), readFailed(path))
      .andThen((handle) => closeAfter(handle, headerFromHandle(handle, path)))
      .map((file) => {
        span.setAttributes({ "edf.format": file.header.format, "edf.verdict": file.size.verdict });
        if (file.size.verdict !== "reject") {
          span.setAttributes({
            "edf.records": file.size.records,
            "edf.header_count": file.size.header,
          });
        }

        reportWarnings(span, logger, file.warnings);

        return file;
      });
  });
}

function headerFromHandle(
  handle: FileHandle,
  path: string,
): ResultAsync<EdfFileHeaders, EdfFileError> {
  const readFirstBytes = (length: number): ResultAsync<Uint8Array, ReadFailed> =>
    ResultAsync.fromPromise(
      handle.read(new Uint8Array(length), 0, length, 0),
      readFailed(path),
    ).map(({ buffer, bytesRead }) => buffer.subarray(0, bytesRead));
  const parse = (bytes: Uint8Array, size: number): Result<EdfFileHeaders, EdfFileError> =>
    readHeader(bytes, size).mapErr(withPath(path));

  return ResultAsync.fromPromise(handle.stat(), readFailed(path)).andThen(({ size }) =>
    readFirstBytes(Math.min(FIXED_BYTES, size))
      .andThen((bytes) => parse(bytes, size))
      // Reads the rest of the header when the first 256 bytes declare a longer one. When the file is
      // shorter than its declared header, the code skips the second read and returns the first
      // `header_too_short` error.
      .orElse((error) =>
        error.kind === "header_too_short" &&
        error.headerBytes > FIXED_BYTES &&
        error.headerBytes <= size
          ? readFirstBytes(error.headerBytes).andThen((bytes) => parse(bytes, size))
          : errAsync(error),
      ),
  );
}

// Closes `handle` after `work` settles, whether `work` succeeds or fails.
function closeAfter<T, E>(handle: FileHandle, work: ResultAsync<T, E>): ResultAsync<T, E> {
  return new ResultAsync(
    (async () => {
      try {
        return await work;
      } finally {
        await handle.close();
      }
    })(),
  );
}

/**
 * Resolves to the `path`, `checksum`, and `bad_records` columns of a file's `files` row, which the
 * two checksum checks fill.
 */
export type FileCheck = Pick<FileRow, "path" | "checksum" | "bad_records">;

/** Pairs a file that `readEdfFile` read with its checksum checks. */
export type CheckedFile<T> = { file: T; check: FileCheck };

// Reads the .crc beside the EDF file at `path`. Returns null when the file has no .crc, and an
// error with the .crc's path when it can't read the .crc.
function readCompanion(
  ctx: Pick<AppContext, "config">,
  path: string,
): ResultAsync<Uint8Array | null, EdfFileError> {
  const crcPath = path.replace(/\.edf$/v, ".crc");

  return readCpapFile(ctx, crcPath)
    .map((bytes): Uint8Array | null => bytes)
    .orElse((error) => (isNotFound(error.cause) ? okAsync(null) : errAsync(error)));
}

/**
 * Reads the whole EDF file at `path` and parses it with `readEdf` as `type`, in an
 * `edf.read_file` span. `path` is relative to the CPAP data folder. It also compares the file with
 * the `.crc` beside it, and sets the checksum to `unchecked` when the file has no `.crc`. The span
 * records the path, the format, the number of whole records on disk, the warning count, the
 * checksum result, and the number of bad records. This function only counts the header's warnings,
 * because `readEdfHeader` logged them when the readiness check read the header. It logs a `.crc`
 * mismatch and the bad records at `warn`.
 *
 * Returns `read_failed`, with the path of the file that failed, when it can't read the file or its
 * `.crc`. Returns `readEdf`'s error for a file that doesn't match `type`.
 */
export function readEdfFile<F extends EdfSignalFileType>(
  ctx: Pick<AppContext, "config" | "logger">,
  path: string,
  type: F,
): ResultAsync<CheckedFile<EdfFile<F>>, EdfFileError>;
export function readEdfFile<F extends EdfAnnotationFileType>(
  ctx: Pick<AppContext, "config" | "logger">,
  path: string,
  type: F,
): ResultAsync<CheckedFile<EdfFile<F>>, EdfFileError>;
export function readEdfFile(
  ctx: Pick<AppContext, "config" | "logger">,
  path: string,
  type: EdfFileType,
): ResultAsync<CheckedFile<EdfSignalFile<string> | EdfAnnotationFile>, EdfFileError> {
  const logger = ctx.logger.child({ module: "ingest.edf", path });

  return inSpanAsync("edf.read_file", (span) => {
    span.setAttribute("airway.file.path", path);

    return readCpapFile(ctx, path)
      .andThen((bytes) =>
        readEdf(bytes, type)
          .map((file) => ({ bytes, file }))
          .mapErr(withPath(path)),
      )
      .andThen(({ bytes, file }) =>
        readCompanion(ctx, path).map((crc) => ({
          file,
          check: {
            path,
            checksum: crc === null ? FileChecksum.Unchecked : checkCompanion(bytes, crc),
            bad_records: file.badRecords.length,
          },
        })),
      )
      .map((read) => {
        const { file, check } = read;

        span.setAttributes({
          "edf.format": file.header.format,
          "edf.records": file.records,
          "edf.warning_count": file.warnings.length,
          "edf.checksum": check.checksum,
          "edf.bad_records": file.badRecords.length,
        });

        if (check.checksum === FileChecksum.Mismatch) {
          logger.warn("EDF file doesn't match its .crc");
        }

        if (file.badRecords.length > 0) {
          logger.warn({ badRecords: file.badRecords }, "EDF records don't match their Crc16");
        }

        return read;
      });
  });
}
