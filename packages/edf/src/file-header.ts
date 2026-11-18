import { open, type FileHandle } from "node:fs/promises";
import { errAsync, ResultAsync } from "neverthrow";
import { readHeader, type EdfFile, type EdfReadError } from "./header.ts";

// The fixed part of every header, which says how long the whole header is.
const FIXED_BYTES = 256;

/**
 * Reads a file's header from disk, without reading its records, and checks the file's size
 * against it. It reads the first 256 bytes, then the rest of the header if there's more.
 */
export function readFileHeader(path: string): ResultAsync<EdfFile, EdfReadError> {
  const failed = (cause: unknown): EdfReadError => ({
    kind: "read_failed",
    path,
    message: cause instanceof Error ? cause.message : String(cause),
  });

  return ResultAsync.fromPromise(open(path, "r"), failed).andThen((handle) =>
    closeAfter(handle, readHeaderFromHandle(handle, failed)),
  );
}

function readHeaderFromHandle(
  handle: FileHandle,
  failed: (cause: unknown) => EdfReadError,
): ResultAsync<EdfFile, EdfReadError> {
  const readFirstBytes = (length: number): ResultAsync<Uint8Array, EdfReadError> =>
    ResultAsync.fromPromise(handle.read(new Uint8Array(length), 0, length, 0), failed).map(
      ({ buffer, bytesRead }) => buffer.subarray(0, bytesRead),
    );

  return ResultAsync.fromPromise(handle.stat(), failed).andThen(({ size }) =>
    readFirstBytes(Math.min(FIXED_BYTES, size))
      .andThen((bytes) => readHeader(bytes, size))
      // The first 256 bytes give the header's length; a file shorter than that is truncated.
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
