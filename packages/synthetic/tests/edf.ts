import { readAnnotations, type Annotation } from "@airway/edf/annotations";
import { isReadable, readHeader, type ReadableEdfFile } from "@airway/edf/header";

/** Reads the header of `bytes` and throws unless `isReadable` accepts the file. */
export function readable(bytes: Uint8Array): ReadableEdfFile {
  const file = readHeader(bytes)._unsafeUnwrap();

  if (!isReadable(file)) {
    throw new Error(`expected a readable file, got ${JSON.stringify(file.size)}`);
  }

  return file;
}

/** Returns every annotation in an EVE or CSL file. */
export const annotationsOf = (bytes: Uint8Array): Annotation[] =>
  readAnnotations(bytes, readable(bytes))._unsafeUnwrap();
