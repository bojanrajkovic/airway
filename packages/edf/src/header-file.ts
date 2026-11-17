import { open, type FileHandle } from "node:fs/promises";
import { err, ResultAsync, type Result } from "neverthrow";
import { readHeader, type EdfFile, type EdfReadError } from "./header.ts";

// The fixed part of every header, which says how long the whole header is.
const FIXED_BYTES = 256;

/**
 * Reads a file's header from disk, without reading its records, and checks the file's size
 * against it. It reads the first 256 bytes, then the rest of the header if there's more.
 */
export function readHeaderFile(path: string): ResultAsync<EdfFile, EdfReadError> {
  return ResultAsync.fromPromise(open(path, "r"), (cause) => readFailed(path, cause)).andThen(
    (handle) => new ResultAsync(readOpen(path, handle)),
  );
}

async function readOpen(path: string, handle: FileHandle): Promise<Result<EdfFile, EdfReadError>> {
  try {
    const { size } = await handle.stat();
    const start = async (length: number): Promise<Uint8Array> => {
      const bytes = new Uint8Array(length);
      const { bytesRead } = await handle.read(bytes, 0, length, 0);

      return bytes.subarray(0, bytesRead);
    };

    const first = readHeader(await start(Math.min(FIXED_BYTES, size)), size);

    // The first 256 bytes give the header's length; a file shorter than that is truncated.
    if (first.isErr() && first.error.kind === "header_too_short") {
      const { headerBytes } = first.error;

      return headerBytes > FIXED_BYTES && headerBytes <= size
        ? readHeader(await start(headerBytes), size)
        : first;
    }

    return first;
  } catch (cause) {
    return err(readFailed(path, cause));
  } finally {
    await handle.close();
  }
}

const readFailed = (path: string, cause: unknown): EdfReadError => ({
  kind: "read_failed",
  path,
  message: cause instanceof Error ? cause.message : String(cause),
});
