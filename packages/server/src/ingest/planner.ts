import type { StrDay } from "@airway/contract/derived/str";
import { FileKind } from "@airway/contract/derived/values";
import type { EveFile } from "./events.ts";
import type { ScannedFile } from "./scan.ts";
import type { NightFiles, SegmentFile } from "./segments.ts";
import type { FileStates, FileVersion, ReadyFile, RejectedFile } from "./versions.ts";

/** Describes what a poll should import. */
export type NightPlan = {
  /**
   * Ingest imports these nights, oldest first. Each has a new or changed ready file and isn't in
   * `waiting`.
   */
  nights: Temporal.PlainDate[];
  /**
   * Ingest postpones these nights, because one of their files is waiting, or because STR.edf isn't
   * ready or doesn't cover them.
   */
  waiting: Temporal.PlainDate[];
  /** The planner ignores these files when it decides whether to import a night. */
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
  const covered = strCovers(states.ready.find(({ kind }) => kind === FileKind.Str));
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
      (file) =>
        (file.kind === FileKind.Str || file.kind === FileKind.Identification) &&
        isNew(file, versions),
    ),
  };
}

/** Returns a predicate that tells whether a scanned file is in `night`'s DATALOG folder. */
export const inNight =
  (night: Temporal.PlainDate) =>
  (file: ScannedFile): boolean =>
    file.night?.equals(night) === true;

/**
 * Resolves to the tasks for a poll's planned nights. `unused` lists the planned nights whose STR.edf
 * day is unused. Until the machine rewrites STR.edf around noon, the record for the night that just
 * ended has -1 in every field, so that night is in `unused`.
 */
export type NightTasks = { tasks: NightFiles[]; unused: Temporal.PlainDate[] };

/** Tells whether a ready file is a BRP or PLD file whose header passed the size check. */
export const isSegmentFile = (file: ReadyFile): file is SegmentFile =>
  (file.kind === FileKind.Brp || file.kind === FileKind.Pld) &&
  file.edf !== null &&
  file.edf.size.verdict !== "reject";

/** Tells whether a ready file is an EVE file with its headers. */
export const isEveFile = (file: ReadyFile): file is EveFile =>
  file.kind === FileKind.Eve && file.edf !== null;

/**
 * Builds a `NightFiles` for each of `nights` from the files in its DATALOG folder, matched by the
 * scan's `night` field. A night whose STR.edf day is unused, or that STR.edf doesn't cover, goes in
 * `unused`. The planner holds back nights that STR.edf doesn't cover, so in practice every night
 * in `unused` has an unused STR.edf day.
 */
export function planTasks(
  nights: readonly Temporal.PlainDate[],
  states: FileStates,
  days: readonly StrDay[],
  zone: string,
): NightTasks {
  const byDay = new Map(days.map((day) => [day.day.toString(), day]));

  return nights.reduce<NightTasks>(
    (planned, night) => {
      const day = byDay.get(night.toString());

      if (day?.used !== true) {
        planned.unused.push(night);

        return planned;
      }

      const ready = states.ready.filter(inNight(night));

      planned.tasks.push({
        night,
        zone,
        day,
        files: ready.filter(isSegmentFile),
        eveFiles: ready.filter(isEveFile),
        rejected: states.rejected.filter(
          (file) => inNight(night)(file) && file.kind !== FileKind.Crc,
        ),
        crcFiles: ready.filter((file) => file.kind === FileKind.Crc),
      });

      return planned;
    },
    { tasks: [], unused: [] },
  );
}
