import type { EdfFile, EdfReadError } from "@airway/edf/header";

/** How long a file's size and ctime must hold before it's imported. */
export const STABLE_FOR = Temporal.Duration.from({ minutes: 2 });

/** A file's header, as last read: parsed, failed, or not EDF (Identification.tgt). */
export type HeaderRead =
  | { kind: "read"; file: EdfFile }
  | { kind: "failed"; error: EdfReadError }
  | { kind: "not_edf" };

/** What ingest remembers about one path between polls. */
export type SeenFile = {
  size: number;
  ctime: Temporal.Instant;
  /** When this size and ctime were first seen. */
  since: Temporal.Instant;
  header: HeaderRead;
  /** Set once the file is ready and hashed; cleared when it changes. */
  sha256: string | null;
  /** Whether this version's rejection has been logged. */
  rejectionLogged: boolean;
};

export type RejectReason = "truncated" | "partial_record" | "unreadable";

export type Readiness =
  | { state: "waiting"; reason: "size_changed" | "too_soon" }
  | { state: "ready" }
  | { state: "rejected"; reason: RejectReason };

/**
 * Whether a file can be imported. It waits until its size and ctime have held for STABLE_FOR, so a
 * half-written file isn't judged by a partial header. Then its header decides: a file the size check
 * rejects, or whose header can't be parsed, is rejected; anything else is ready. `previous` is the
 * file's state before this poll, used only to say why it waits.
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
