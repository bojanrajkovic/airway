// Reads files from the CPAP data folder and reports why a read failed.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import type { AppContext } from "../runtime/context.ts";

/**
 * Reports that the file system couldn't read a file or folder. `path` is the file's path relative
 * to the CPAP data folder, or the folder's own path when the folder can't be read. `cause` is the
 * error that the read threw.
 */
export type ReadFailed = { kind: "read_failed"; path: string; cause: unknown };

/** Returns a function that turns a read's thrown error into a `ReadFailed` for `path`. */
export const readFailed =
  (path: string) =>
  (cause: unknown): ReadFailed => ({ kind: "read_failed", path, cause });

/** Tells whether a read's error means the file doesn't exist. */
export const isNotFound = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** Reads the whole file at `path`, relative to the CPAP data folder. */
export const readCpapFile = (
  ctx: Pick<AppContext, "config">,
  path: string,
): ResultAsync<Uint8Array, ReadFailed> =>
  ResultAsync.fromPromise(readFile(join(ctx.config.cpapDataPath, path)), readFailed(path));
