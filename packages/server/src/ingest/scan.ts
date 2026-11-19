import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import type { FILE_KINDS } from "@airway/contract/derived/values";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";

/** A file ingest reads, as one stat call saw it. `path` is relative to the CPAP data folder. */
export type ScannedFile = {
  path: string;
  kind: (typeof FILE_KINDS)[number];
  /** The DATALOG folder's date; null for STR.edf and Identification.tgt. */
  night: Temporal.PlainDate | null;
  size: number;
  ctime: Temporal.Instant;
};

export const SKIP_REASONS = ["sad", "csl", "crc", "other", "folder", "vanished"] as const;

/** What a scan found, and how many entries it passed over, by reason. */
export type Scan = {
  files: ScannedFile[];
  skipped: Record<(typeof SKIP_REASONS)[number], number>;
};

export type ScanError = { kind: "read_failed"; path: string; message: string };

// A night file's kind or skip reason, by the last 8 characters of its name.
const NIGHT_FILES: Readonly<Record<string, ScannedFile["kind"]>> = {
  "_BRP.edf": "brp",
  "_PLD.edf": "pld",
  "_EVE.edf": "eve",
};
const SKIPPED_NIGHT_FILES: Readonly<Record<string, "sad" | "csl">> = {
  "_SAD.edf": "sad",
  "_CSL.edf": "csl",
};
const ROOT_FILES: Readonly<Record<string, ScannedFile["kind"]>> = {
  "STR.edf": "str",
  "Identification.tgt": "identification",
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** A DATALOG folder name as a night, or null when it isn't a real YYYYMMDD date. */
function nightOf(name: string): Temporal.PlainDate | null {
  if (!/^\d{8}$/v.test(name)) {
    return null;
  }

  try {
    return Temporal.PlainDate.from(name);
  } catch {
    return null;
  }
}

/**
 * Lists the CPAP data folder's STR.edf, Identification.tgt, and each DATALOG/YYYYMMDD folder's
 * BRP, PLD, and EVE files, without opening any of them. SAD, CSL, .crc, other entries, folders
 * that aren't dates, and files that vanish between listing and stat are counted and skipped. A
 * missing DATALOG folder means no nights yet.
 */
export function scanCpapData(ctx: AppContext): ResultAsync<Scan, ScanError> {
  const root = ctx.config.cpapDataPath;

  return inSpanAsync("ingest.scan", (span) =>
    ResultAsync.fromPromise(walk(root), (cause): ScanError => ({
      kind: "read_failed",
      path: root,
      message: cause instanceof Error ? cause.message : String(cause),
    })).map((scan) => {
      span.setAttribute("airway.files", scan.files.length);
      for (const reason of SKIP_REASONS) {
        span.setAttribute(`airway.skipped.${reason}`, scan.skipped[reason]);
      }

      return scan;
    }),
  );
}

async function walk(root: string): Promise<Scan> {
  const scan: Scan = {
    files: [],
    skipped: { sad: 0, csl: 0, crc: 0, other: 0, folder: 0, vanished: 0 },
  };

  // Stats one entry and adds it, or counts it as vanished when the card removed it mid-scan.
  async function add(
    path: string,
    kind: ScannedFile["kind"],
    night: Temporal.PlainDate | null,
  ): Promise<void> {
    try {
      const stats = await stat(join(root, path), { bigint: true });

      scan.files.push({
        path,
        kind,
        night,
        size: Number(stats.size),
        ctime: Temporal.Instant.fromEpochNanoseconds(stats.ctimeNs),
      });
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }

      scan.skipped.vanished++;
    }
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const kind = entry.isFile() ? ROOT_FILES[entry.name] : undefined;

    if (kind !== undefined) {
      await add(entry.name, kind, null);
    } else if (entry.name !== "DATALOG") {
      scan.skipped[entry.name.endsWith(".crc") ? "crc" : "other"]++;
    }
  }

  for (const folder of await entries(join(root, "DATALOG"))) {
    const night = folder.isDirectory() ? nightOf(folder.name) : null;

    if (night === null) {
      scan.skipped.folder++;
      continue;
    }

    for (const entry of await entries(join(root, "DATALOG", folder.name))) {
      const suffix = entry.isFile() ? entry.name.slice(-8) : "";
      const kind = NIGHT_FILES[suffix];
      const skip = SKIPPED_NIGHT_FILES[suffix];

      if (kind !== undefined) {
        await add(`DATALOG/${folder.name}/${entry.name}`, kind, night);
      } else if (skip !== undefined) {
        scan.skipped[skip]++;
      } else if (entry.name.endsWith(".crc")) {
        scan.skipped.crc++;
      } else {
        scan.skipped.other++;
      }
    }
  }

  return scan;
}

// A folder's entries, or none when it's gone: DATALOG before the first night, or a night folder
// removed mid-scan.
async function entries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
}
