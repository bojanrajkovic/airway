import { readAnnotations, type EdfAnnotation } from "@airway/edf/annotations";
import { isReadable, readHeader, type ReadableEdfFileHeaders } from "@airway/edf/header";

/** Reads the header of `bytes` and throws unless `isReadable` accepts the file. */
export function readable(bytes: Uint8Array): ReadableEdfFileHeaders {
  const file = readHeader(bytes)._unsafeUnwrap();

  if (!isReadable(file)) {
    throw new Error(`expected a readable file, got ${JSON.stringify(file.size)}`);
  }

  return file;
}

/** Returns every annotation in an EVE or CSL file. */
export const annotationsOf = (bytes: Uint8Array): EdfAnnotation[] =>
  readAnnotations(bytes, readable(bytes))._unsafeUnwrap();
