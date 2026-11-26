import { open, readFile, type FileHandle } from "node:fs/promises";
import { errAsync, ResultAsync } from "neverthrow";
import type { EdfAnnotationFileType, EdfFileType, EdfSignalFileType } from "./airsense.ts";
import { readEdf, type EdfAnnotationFile, type EdfFile, type EdfSignalFile } from "./file.ts";
import { readHeader, type EdfFileHeaders, type EdfReadError } from "./header.ts";

// Every header starts with 256 fixed bytes, which say how long the whole header is.
const FIXED_BYTES = 256;

const readFailed =
  (path: string) =>
  (cause: unknown): EdfReadError => ({ kind: "read_failed", path, cause });

/**
 * Reads a file's header from disk, without reading its records, and checks the file's size
 * against the header. It reads the first 256 bytes, then the rest of the header if there's more.
 */
export function readFileHeader(path: string): ResultAsync<EdfFileHeaders, EdfReadError> {
  const failed = readFailed(path);

  return ResultAsync.fromPromise(open(path, "r"), failed).andThen((handle) =>
    closeAfter(handle, readHeaderFromHandle(handle, failed)),
  );
}

function readHeaderFromHandle(
  handle: FileHandle,
  failed: (cause: unknown) => EdfReadError,
): ResultAsync<EdfFileHeaders, EdfReadError> {
  const readFirstBytes = (length: number): ResultAsync<Uint8Array, EdfReadError> =>
    ResultAsync.fromPromise(handle.read(new Uint8Array(length), 0, length, 0), failed).map(
      ({ buffer, bytesRead }) => buffer.subarray(0, bytesRead),
    );

  return ResultAsync.fromPromise(handle.stat(), failed).andThen(({ size }) =>
    readFirstBytes(Math.min(FIXED_BYTES, size))
      .andThen((bytes) => readHeader(bytes, size))
      // The first 256 bytes say how long the header is; a file shorter than the header is truncated.
      .orElse((error) =>
        error.kind === "header_too_short" &&
        error.headerBytes > FIXED_BYTES &&
        error.headerBytes <= size
          ? readFirstBytes(error.headerBytes).andThen((bytes) => readHeader(bytes, size))
          : errAsync(error),
      ),
  );
}

// Closes the file once the work settles, whether it succeeded or not.
function closeAfter<T>(
  handle: FileHandle,
  work: ResultAsync<T, EdfReadError>,
): ResultAsync<T, EdfReadError> {
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
 * Reads the file at `path` and passes its bytes to `readEdf`. Returns `read_failed` for a file it
 * can't read, and returns `readEdf`'s error for a file that doesn't match `type`.
 */
export function readEdfFile<F extends EdfSignalFileType>(
  path: string,
  type: F,
): ResultAsync<EdfFile<F>, EdfReadError>;
export function readEdfFile<F extends EdfAnnotationFileType>(
  path: string,
  type: F,
): ResultAsync<EdfFile<F>, EdfReadError>;
export function readEdfFile(
  path: string,
  type: EdfFileType,
): ResultAsync<EdfSignalFile<string> | EdfAnnotationFile, EdfReadError> {
  return ResultAsync.fromPromise(readFile(path), readFailed(path)).andThen((bytes) =>
    readEdf(bytes, type),
  );
}
