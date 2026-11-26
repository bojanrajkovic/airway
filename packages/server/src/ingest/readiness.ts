import type { EdfFile, EdfReadError } from "@airway/edf/header";

/** Ingest imports a file once its size and ctime have stayed the same for this long. */
export const STABLE_FOR = Temporal.Duration.from({ minutes: 2 });

/**
 * Says how the last read of a file's header ended. `read` means the header parsed, and `failed`
 * means the read or the parse failed. `not_edf` marks Identification.tgt and .crc files, which
 * aren't EDF files.
 */
export type HeaderRead =
  | { kind: "read"; file: EdfFile }
  | { kind: "failed"; error: EdfReadError }
  | { kind: "not_edf" };

/** Ingest remembers these fields about each path between polls. */
export type SeenFile = {
  size: number;
  ctime: Temporal.Instant;
  /** When ingest first saw this size and ctime. */
  since: Temporal.Instant;
  header: HeaderRead;
  /** Ingest hashes the file once it's ready, and clears the hash when the file changes. */
  sha256: string | null;
  /** True once ingest has logged that it rejected this version of the file. */
  rejectionLogged: boolean;
};

export type RejectReason = "truncated" | "partial_record" | "unreadable";

export type Readiness =
  | { state: "waiting"; reason: "size_changed" | "too_soon" }
  | { state: "ready" }
  | { state: "rejected"; reason: RejectReason };

/**
 * Returns whether ingest can import a file:
 *
 * - `waiting` until the file's size and ctime have stayed the same for STABLE_FOR, because a
 *   half-written file can have a partial header. The reason is `size_changed` when the size differs
 *   from `previous`, and `too_soon` otherwise.
 * - `rejected` when reading the header failed, or when the size check rejected the file.
 * - `ready` otherwise.
 */
export function checkReadiness(
  previous: SeenFile | undefined,
  current: SeenFile,
  now: Temporal.Instant,
): Readiness {
  if (Temporal.Duration.compare(now.since(current.since), STABLE_FOR) < 0) {
    const resized = previous !== undefined && previous.size !== current.size;

    return { state: "waiting", reason: resized ? "size_changed" : "too_soon" };
  }

  const { header } = current;

  if (header.kind === "failed") {
    return { state: "rejected", reason: "unreadable" };
  }

  if (header.kind === "read" && header.file.size.verdict === "reject") {
    return { state: "rejected", reason: header.file.size.reason };
  }

  return { state: "ready" };
}
