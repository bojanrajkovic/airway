import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import { FileKind } from "@airway/contract/derived/values";
import { valuesOf } from "@airway/contract/enum";
import { nightFileType, type NightFileType } from "@airway/edf/airsense";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";

/**
 * Describes a file that ingest reads. `size` and `ctime` come from one stat call, and `path` is
 * relative to the CPAP data folder.
 */
export type ScannedFile = {
  path: string;
  kind: FileKind;
  /**
   * `night` is the date of the file's DATALOG folder. It's null for STR.edf and
   * Identification.tgt.
   */
  night: Temporal.PlainDate | null;
  size: number;
  ctime: Temporal.Instant;
};

export enum SkipReason {
  Sad = "sad",
  Csl = "csl",
  Crc = "crc",
  Other = "other",
  Folder = "folder",
}

/** Lists the files that a scan found, and counts the entries that it skipped for each reason. */
export type Scan = {
  files: ScannedFile[];
  skipped: Record<SkipReason, number>;
};

export type ScanError = { kind: "read_failed"; path: string; cause: unknown };

// Ingest imports BRP, PLD, and EVE files and skips SAD and CSL files.
const IMPORTED_NIGHT_FILES: Partial<Record<NightFileType, ScannedFile["kind"]>> = {
  brp: FileKind.Brp,
  pld: FileKind.Pld,
  eve: FileKind.Eve,
};
const SKIPPED_NIGHT_FILES: Partial<Record<NightFileType, SkipReason>> = {
  sad: SkipReason.Sad,
  csl: SkipReason.Csl,
};

/**
 * Reads the kind of a night file from its name, for the files that the scan lists. The scan also
 * lists the .crc file of each file that ingest imports, so that import can verify the checksum.
 * Returns undefined for any other name.
 */
export function nightFileKind(name: string): ScannedFile["kind"] | undefined {
  const file = nightFileType(name);
  const kind = file === undefined ? undefined : IMPORTED_NIGHT_FILES[file.type];

  return kind !== undefined && file?.crc === true ? FileKind.Crc : kind;
}

// Returns the reason that the scan skips a night file, or undefined for any other name.
function skipReason(name: string): SkipReason | undefined {
  const file = nightFileType(name);
  const reason = file === undefined ? undefined : SKIPPED_NIGHT_FILES[file.type];

  return reason !== undefined && file?.crc === true ? SkipReason.Crc : reason;
}

const ROOT_FILES: Readonly<Record<string, ScannedFile["kind"]>> = {
  "STR.edf": FileKind.Str,
  "Identification.tgt": FileKind.Identification,
  "Identification.crc": FileKind.Crc,
};

/** Parses a DATALOG folder name as a night. Returns null when the name isn't a YYYYMMDD date. */
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
 * Lists the files that ingest reads in the CPAP data folder, each with its .crc file:
 *
 * - STR.edf
 * - Identification.tgt
 * - the BRP, PLD, and EVE files in each DATALOG/YYYYMMDD folder
 *
 * The scan reads only each file's size and ctime, with one stat call per file. It treats a missing
 * DATALOG folder as empty. Any read error fails the scan, and the next poll tries again.
 *
 * The scan skips and counts these entries:
 *
 * - SAD and CSL files and their .crc files
 * - DATALOG folders whose names aren't dates
 * - every other entry
 */
export function scanCpapData(ctx: AppContext): ResultAsync<Scan, ScanError> {
  const root = ctx.config.cpapDataPath;

  return inSpanAsync("ingest.scan", (span) =>
    ResultAsync.fromPromise(walk(root), (cause): ScanError => ({
      kind: "read_failed",
      path: root,
      cause,
    })).map((scan) => {
      span.setAttribute("airway.files", scan.files.length);
      for (const reason of valuesOf(SkipReason)) {
        span.setAttribute(`airway.skipped.${reason}`, scan.skipped[reason]);
      }

      return scan;
    }),
  );
}

async function walk(root: string): Promise<Scan> {
  const scan: Scan = {
    files: [],
    skipped: {
      [SkipReason.Sad]: 0,
      [SkipReason.Csl]: 0,
      [SkipReason.Crc]: 0,
      [SkipReason.Other]: 0,
      [SkipReason.Folder]: 0,
    },
  };
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
      scan.skipped[SkipReason.Other]++;
    }
  }

  // The scan treats a missing DATALOG folder as empty.
  const folders = hasDatalog ? await readdir(join(root, "DATALOG"), { withFileTypes: true }) : [];

  for (const folder of folders) {
    const night = folder.isDirectory() ? nightOf(folder.name) : null;

    if (night === null) {
      scan.skipped[SkipReason.Folder]++;
      continue;
    }

    for (const entry of await readdir(join(root, "DATALOG", folder.name), {
      withFileTypes: true,
    })) {
      const name = entry.isFile() ? entry.name : "";
      const kind = nightFileKind(name);
      const skip = skipReason(name);

      if (kind !== undefined) {
        await add(`DATALOG/${folder.name}/${entry.name}`, kind, night);
      } else if (skip !== undefined) {
        scan.skipped[skip]++;
      } else {
        scan.skipped[SkipReason.Other]++;
      }
    }
  }

  return scan;
}
