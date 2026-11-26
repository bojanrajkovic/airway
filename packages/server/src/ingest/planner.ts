import type { ScannedFile } from "./scan.ts";
import type { FileStates, FileVersion, ReadyFile, RejectedFile } from "./versions.ts";

/** What a poll should import. */
export type NightPlan = {
  /**
   * The nights to import, oldest first. Each has a new or changed ready file and isn't in
   * `waiting`.
   */
  nights: Temporal.PlainDate[];
  /**
   * Nights that can't be imported yet, because one of their files is waiting, or because STR.edf
   * isn't ready or doesn't cover them.
   */
  waiting: Temporal.PlainDate[];
  /** The rejected files. The planner ignores them when it decides whether to import a night. */
  rejected: RejectedFile[];
  /** STR.edf or Identification.tgt has a new ready version, so their tables need rewriting. */
  rewriteStrTables: boolean;
};

const isNew = (file: ReadyFile, imported: ReadonlyMap<string, FileVersion>): boolean => {
  const version = imported.get(file.path);

  return version?.size !== file.size || version.sha256 !== file.sha256;
};

/**
 * Returns a function that tells whether STR.edf has a record for a night. Each whole record covers
 * one day, starting on STR.edf's start date.
 */
function strCovers(str: ReadyFile | undefined): (night: Temporal.PlainDate) => boolean {
  if (str?.edf?.size.verdict !== "read") {
    return () => false;
  }

  const start = str.edf.header.start.toPlainDate();
  const end = start.add({ days: str.edf.size.records });

  return (night) =>
    Temporal.PlainDate.compare(night, start) >= 0 && Temporal.PlainDate.compare(night, end) < 0;
}

/**
 * Decides which nights a poll imports, from the readiness of the poll's files and the versions
 * already imported.
 *
 * - A night is imported when one of its ready files is new or changed.
 * - A night waits while any of its files waits, or while STR.edf isn't ready or has no record for
 *   the night.
 * - Rejected files are ignored, so a file that never finishes can't make its night wait.
 * - A rejected file is never imported, so a later complete version of it counts as new.
 * - Imported files that are missing from the folder are ignored.
 */
export function planNights(states: FileStates, imported: readonly FileVersion[]): NightPlan {
  const versions = new Map(imported.map((version) => [version.path, version]));
  const covered = strCovers(states.ready.find(({ kind }) => kind === "str"));
  const nightKeys = (files: readonly ScannedFile[]): Set<string> =>
    new Set(files.flatMap(({ night }) => (night === null ? [] : [night.toString()])));

  const held = nightKeys(states.waiting);
  const changed = nightKeys(states.ready.filter((file) => isNew(file, versions)));
  const nights = [...nightKeys([...states.ready, ...states.waiting, ...states.rejected])]
    .map((night) => Temporal.PlainDate.from(night))
    .toSorted((a, b) => Temporal.PlainDate.compare(a, b));
  const waits = (night: Temporal.PlainDate): boolean =>
    held.has(night.toString()) || !covered(night);

  return {
    nights: nights.filter((night) => changed.has(night.toString()) && !waits(night)),
    waiting: nights.filter(waits),
    rejected: states.rejected,
    rewriteStrTables: states.ready.some(
      (file) => (file.kind === "str" || file.kind === "identification") && isNew(file, versions),
    ),
  };
}
