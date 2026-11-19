import type { ScannedFile } from "./scan.ts";
import type { FileStates, FileVersion, ReadyFile, RejectedFile } from "./versions.ts";

/** What a poll should import. */
export type NightPlan = {
  /** Nights with a new or changed ready file and nothing waiting, oldest first. */
  nights: Temporal.PlainDate[];
  /** Nights held by a waiting file, or by STR.edf not being ready or not covering them. */
  waiting: Temporal.PlainDate[];
  /** Files left out of their nights. */
  rejected: RejectedFile[];
  /** STR.edf or Identification.tgt has a new ready version, so their tables need rewriting. */
  rewriteStrTables: boolean;
};

const isNew = (file: ReadyFile, imported: ReadonlyMap<string, FileVersion>): boolean => {
  const version = imported.get(file.path);

  return version?.size !== file.size || version.sha256 !== file.sha256;
};

/** The nights STR.edf has a record for: its start date, then one day per whole record. */
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
 * Plans a poll's imports from its files' readiness and the versions already imported. A night is
 * imported when one of its ready files is new or changed. It waits whole while any of its files
 * waits, or while STR.edf isn't ready or has no record for it. Rejected files are left out, so a
 * hung upload can't hold its night, and because they're never imported, a later complete upload
 * is new and re-plans the night. A file missing from the folder changes nothing.
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
    rewriteStrTables: states.ready.some((file) => file.night === null && isNew(file, versions)),
  };
}
