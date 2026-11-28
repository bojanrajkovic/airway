/**
 * Reports that the file system couldn't read a file or folder. `path` is relative to the CPAP data
 * folder, or the folder itself, and `cause` is the error that the read threw.
 */
export type ReadFailed = { kind: "read_failed"; path: string; cause: unknown };

/** Returns a function that turns a read's thrown error into a `ReadFailed` for `path`. */
export const readFailed =
  (path: string) =>
  (cause: unknown): ReadFailed => ({ kind: "read_failed", path, cause });

/** Tells whether a read's error means the file doesn't exist. */
export const isNotFound = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
