import { isReadable, readHeader, type ReadableEdfFile } from "../src/header.ts";

/** Reads the header of `bytes` and throws unless `isReadable` accepts the file. */
export function readable(bytes: Uint8Array): ReadableEdfFile {
  const file = readHeader(bytes)._unsafeUnwrap();

  if (!isReadable(file)) {
    throw new Error(`expected a readable file, got ${JSON.stringify(file.size)}`);
  }

  return file;
}
