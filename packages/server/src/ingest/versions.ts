import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import type { FileRow } from "@airway/contract/derived/rows";
import { recordBytes, type EdfFileHeaders } from "@airway/edf/header";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { readEdfFile } from "./edf.ts";
import { checkReadiness, type HeaderRead, type RejectReason, type SeenFile } from "./readiness.ts";
import type { Scan, ScannedFile } from "./scan.ts";

/** Identifies one version of an imported file. A new size or hash makes a new version. */
export type FileVersion = Pick<FileRow, "path" | "size" | "sha256">;

/** Describes a file that's ready to import, with its hash. `edf` is the header of an EDF file. */
export type ReadyFile = ScannedFile & FileVersion & { edf: EdfFileHeaders | null };

export type RejectedFile = ScannedFile & { reason: RejectReason };

/** Groups the scanned files by readiness. */
export type FileStates = { ready: ReadyFile[]; waiting: ScannedFile[]; rejected: RejectedFile[] };

type HashError = { kind: "hash_failed"; path: string; cause: unknown };

/**
 * Updates `seen` from this poll's scan and sorts the scanned files by readiness.
 *
 * - A file's header is read only when its size or ctime changed.
 * - A ready file is hashed once per version.
 * - A rejected file is logged once per version.
 * - Paths missing from the scan are removed from `seen`.
 */
export function checkVersions(
  ctx: AppContext,
  seen: Map<string, SeenFile>,
  scan: Scan,
  now: Temporal.Instant,
): ResultAsync<FileStates, never> {
  return inSpanAsync("ingest.readiness", (span) =>
    ResultAsync.fromSafePromise(sort(ctx, seen, scan, now)).map((states) => {
      span.setAttributes({
        "airway.files.ready": states.ready.length,
        "airway.files.waiting": states.waiting.length,
        "airway.files.rejected": states.rejected.length,
      });

      return states;
    }),
  );
}

async function sort(
  ctx: AppContext,
  seen: Map<string, SeenFile>,
  scan: Scan,
  now: Temporal.Instant,
): Promise<FileStates> {
  const logger = ctx.logger.child({ module: "ingest.readiness" });
  const states: FileStates = { ready: [], waiting: [], rejected: [] };
  const scanned = new Set(scan.files.map(({ path }) => path));

  for (const path of seen.keys()) {
    if (!scanned.has(path)) {
      seen.delete(path);
    }
  }

  for (const file of scan.files) {
    const previous = seen.get(file.path);
    const current = await update(ctx, previous, file, now);
    seen.set(file.path, current);

    const readiness = checkReadiness(previous, current, now);

    if (readiness.state === "waiting") {
      states.waiting.push(file);
    } else if (readiness.state === "rejected") {
      states.rejected.push({ ...file, reason: readiness.reason });
      if (!current.rejectionLogged) {
        logRejection(logger, file, readiness.reason, current.header);
        current.rejectionLogged = true;
      }
    } else {
      // A file that can't be hashed is forgotten, so the next poll starts it over.
      const hashed =
        current.sha256 ??
        (await hash(ctx, file.path).match(
          (sha256) => sha256,
          (error) => {
            logger.warn({ error }, "file not hashed");

            return null;
          },
        ));

      if (hashed === null) {
        seen.delete(file.path);
        states.waiting.push(file);
      } else {
        current.sha256 = hashed;
        const edf = current.header.kind === "read" ? current.header.file : null;
        states.ready.push({ ...file, sha256: hashed, edf });
      }
    }
  }

  return states;
}

/**
 * Returns the previous entry when the file's size and ctime are unchanged, and a new entry
 * otherwise. When an I/O error stopped the header read, every poll reads the header again and
 * keeps the entry's `since`.
 */
async function update(
  ctx: AppContext,
  previous: SeenFile | undefined,
  file: ScannedFile,
  now: Temporal.Instant,
): Promise<SeenFile> {
  const unchanged =
    previous !== undefined && previous.size === file.size && previous.ctime.equals(file.ctime)
      ? previous
      : undefined;
  const ioFailed =
    unchanged?.header.kind === "failed" && unchanged.header.error.kind === "read_failed";

  if (unchanged !== undefined && !ioFailed) {
    return unchanged;
  }

  return {
    size: file.size,
    ctime: file.ctime,
    since: unchanged?.since ?? now,
    header: await readHeaderOf(ctx, file),
    sha256: null,
    rejectionLogged: unchanged?.rejectionLogged ?? false,
  };
}

async function readHeaderOf(ctx: AppContext, file: ScannedFile): Promise<HeaderRead> {
  if (file.kind === "identification" || file.kind === "crc") {
    return { kind: "not_edf" };
  }

  return await readEdfFile(ctx, file.path).match(
    (edf): HeaderRead => ({ kind: "read", file: edf }),
    (error): HeaderRead => {
      if (error.kind === "read_failed") {
        ctx.logger
          .child({ module: "ingest.readiness" })
          .warn({ path: file.path, error }, "header not read; retrying next poll");
      }

      return { kind: "failed", error };
    },
  );
}

function logRejection(
  logger: Logger,
  file: ScannedFile,
  reason: RejectReason,
  header: HeaderRead,
): void {
  const counts =
    header.kind === "read"
      ? {
          declaredRecords: header.file.header.declaredRecords,
          recordsOnDisk: Math.floor(
            (file.size - header.file.header.headerBytes) / recordBytes(header.file),
          ),
        }
      : {};
  const error = header.kind === "failed" ? { error: header.error } : {};

  logger.warn({ path: file.path, reason, size: file.size, ...counts, ...error }, "file rejected");
}

/** Streams a file from the CPAP data folder and returns its SHA-256 in hex. */
function hash(ctx: AppContext, path: string): ResultAsync<string, HashError> {
  return inSpanAsync("ingest.hash", (span) => {
    span.setAttribute("airway.file.path", path);

    return ResultAsync.fromPromise(
      new Promise<string>((resolve, reject) => {
        const sha = createHash("sha256");
        createReadStream(join(ctx.config.cpapDataPath, path))
          .on("data", (chunk) => sha.update(chunk))
          .on("end", () => {
            resolve(sha.digest("hex"));
          })
          .on("error", reject);
      }),
      (cause): HashError => ({ kind: "hash_failed", path, cause }),
    );
  });
}
