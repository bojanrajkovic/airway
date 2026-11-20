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

export const SKIP_REASONS = ["sad", "csl", "crc", "other", "folder"] as const;

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
 * BRP, PLD, and EVE files, without opening any of them. SAD, CSL, .crc, other entries, and
 * folders that aren't dates are counted and skipped. A missing DATALOG folder means no nights yet.
 * Any read error fails the scan, and the next poll tries again.
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
  const scan: Scan = { files: [], skipped: { sad: 0, csl: 0, crc: 0, other: 0, folder: 0 } };
  let hasDatalog = false;

  async function add(
    path: string,
    kind: ScannedFile["kind"],
    night: Temporal.PlainDate | null,
  ): Promise<void> {
    const stats = await stat(join(root, path), { bigint: true });

    scan.files.push({
      path,
      kind,
      night,
      size: Number(stats.size),
      ctime: Temporal.Instant.fromEpochNanoseconds(stats.ctimeNs),
    });
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const kind = entry.isFile() ? ROOT_FILES[entry.name] : undefined;

    if (kind !== undefined) {
      await add(entry.name, kind, null);
    } else if (entry.name === "DATALOG" && entry.isDirectory()) {
      hasDatalog = true;
    } else {
      scan.skipped[entry.name.endsWith(".crc") ? "crc" : "other"]++;
    }
  }

  // No DATALOG folder yet means no nights yet.
  const folders = hasDatalog ? await readdir(join(root, "DATALOG"), { withFileTypes: true }) : [];

  for (const folder of folders) {
    const night = folder.isDirectory() ? nightOf(folder.name) : null;

    if (night === null) {
      scan.skipped.folder++;
      continue;
    }

    for (const entry of await readdir(join(root, "DATALOG", folder.name), {
      withFileTypes: true,
    })) {
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
