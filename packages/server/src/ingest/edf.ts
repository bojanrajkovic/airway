// Reads EDF files from the CPAP data folder and runs each read in its own span. @airway/edf
// parses the bytes.
import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Attributes, Span } from "@opentelemetry/api";
import { errAsync, ResultAsync } from "neverthrow";
import type { EdfAnnotationFileType, EdfFileType, EdfSignalFileType } from "@airway/edf/airsense";
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

/** Reports that the file system couldn't read a file. `cause` is the error that it threw. */
type ReadFailed = { kind: "read_failed"; cause: unknown };

/**
 * Reports why a file in the CPAP data folder couldn't be read or parsed. `path` is the file's path
 * relative to the CPAP data folder.
 */
export type EdfFileError = (EdfReadError | ReadFailed) & { path: string };

const readFailed = (cause: unknown): ReadFailed => ({ kind: "read_failed", cause });

// Adds the file's path to an error, because readEdf and readHeader parse bytes and don't know the
// path.
const withPath =
  (path: string) =>
  (error: EdfReadError | ReadFailed): EdfFileError => ({ ...error, path });

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

    return ResultAsync.fromPromise(open(join(ctx.config.cpapDataPath, path), "r"), readFailed)
      .andThen((handle) => closeAfter(handle, headerFromHandle(handle)))
      .mapErr(withPath(path))
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
): ResultAsync<EdfFileHeaders, EdfReadError | ReadFailed> {
  const readFirstBytes = (length: number): ResultAsync<Uint8Array, ReadFailed> =>
    ResultAsync.fromPromise(handle.read(new Uint8Array(length), 0, length, 0), readFailed).map(
      ({ buffer, bytesRead }) => buffer.subarray(0, bytesRead),
    );

  return ResultAsync.fromPromise(handle.stat(), readFailed).andThen(({ size }) =>
    readFirstBytes(Math.min(FIXED_BYTES, size))
      .andThen((bytes) => readHeader(bytes, size))
      // Reads the rest of the header when the first 256 bytes declare a longer one. When the file is
      // shorter than its declared header, the code skips the second read and returns the first
      // `header_too_short` error.
      .orElse((error) =>
        error.kind === "header_too_short" &&
        error.headerBytes > FIXED_BYTES &&
        error.headerBytes <= size
          ? readFirstBytes(error.headerBytes).andThen((bytes) => readHeader(bytes, size))
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
 * Reads the whole EDF file at `path` and parses it with `readEdf` as `type`, in an
 * `edf.read_file` span. `path` is relative to the CPAP data folder. The span records the path,
 * the format, the number of whole records on disk, and the warning count. This function only counts
 * the header's warnings, because `readEdfHeader` logged them when the readiness check read the
 * header.
 * Returns `read_failed` for a file it can't read, and `readEdf`'s error for a file that doesn't
 * match `type`.
 */
export function readEdfFile<F extends EdfSignalFileType>(
  ctx: Pick<AppContext, "config">,
  path: string,
  type: F,
): ResultAsync<EdfFile<F>, EdfFileError>;
export function readEdfFile<F extends EdfAnnotationFileType>(
  ctx: Pick<AppContext, "config">,
  path: string,
  type: F,
): ResultAsync<EdfFile<F>, EdfFileError>;
export function readEdfFile(
  ctx: Pick<AppContext, "config">,
  path: string,
  type: EdfFileType,
): ResultAsync<EdfSignalFile<string> | EdfAnnotationFile, EdfFileError> {
  return inSpanAsync("edf.read_file", (span) => {
    span.setAttribute("airway.file.path", path);

    return ResultAsync.fromPromise(readFile(join(ctx.config.cpapDataPath, path)), readFailed)
      .andThen((bytes) => readEdf(bytes, type))
      .mapErr(withPath(path))
      .map((file) => {
        span.setAttributes({
          "edf.format": file.header.format,
          "edf.records": file.records,
          "edf.warning_count": file.warnings.length,
        });

        return file;
      });
  });
}
