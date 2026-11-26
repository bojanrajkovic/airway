import { createHash } from "node:crypto";
import { Result } from "neverthrow";
import { EventSource, FileKind } from "@airway/contract/derived/values";
import type { EdfReadError } from "@airway/edf/header";
import type { FileSizeCheck } from "@airway/edf/size";
import type {
  BreathRow,
  DerivedRows,
  EventRow,
  FileRow,
  SampleRow,
  SegmentRow,
  SessionRow,
  SignalValues,
} from "@airway/contract/derived/rows";
import { nightRow } from "@airway/contract/derived/nights";
import { assignEvents, buildSessions } from "@airway/contract/derived/sessions";
import { settingsChanges } from "@airway/contract/derived/settings";
import type { StrDay, UsedStrDay } from "@airway/contract/derived/str";
import { EVENT_LABELS, PLD_SAMPLE_SECONDS } from "@airway/edf/airsense";
import { PLD_SAMPLE_COLUMNS, STR_NIGHT_COLUMNS, STR_SETTINGS } from "@airway/edf/columns";
import { RuleSet } from "@airway/contract/profile";
import { datalogFiles, folderFiles, type CpapFile, type DatalogFile } from "./cpap-data.ts";
import {
  DEVICE,
  eventFileFor,
  eventOnset,
  writtenDuration,
  maskSlots,
  PLD_LAG_SECONDS,
  sizeCheck,
  strFile,
  type SyntheticFileError,
} from "./files.ts";
import type { SyntheticNight } from "./model.ts";
import type { Patient } from "./patients.ts";
import { breaths } from "./signals.ts";

export type SynthesizeOptions = {
  /** A child's nights use the `pediatric` rule set, and an adult's nights use `adult`. */
  patient: Patient;
  /** Sets every file's ctime and every night's `arrived_at`. Ingest reads both from the import. */
  arrivedAt: Temporal.Instant;
};

/** Contains a CPAP data folder and the rows that ingest should derive from it. */
export type Synthesized = { files: CpapFile[]; rows: DerivedRows };

const RULE_SETS: Readonly<Record<Patient, RuleSet>> = {
  child: RuleSet.Pediatric,
  adult: RuleSet.Adult,
};

const value = (n: number | undefined): number | null =>
  n === undefined || Number.isNaN(n) ? null : n;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Returns the CPAP data folder for `nights` and the rows that ingest should derive from it.
 *
 * For a night without segments, `synthesize` returns only a `daily_usage` row, because that night
 * has no files for ingest to read. `loadDerived` writes the `meta` and `period_percentiles` rows.
 */
export function synthesize(
  nights: readonly SyntheticNight[],
  zone: string,
  options: SynthesizeOptions,
): Result<Synthesized, SyntheticFileError> {
  const sorted = [...nights].sort((a, b) => Temporal.PlainDate.compare(a.night, b.night));

  return Result.combine([
    strFile(sorted, zone),
    Result.combine(sorted.map((night) => datalogFiles(night, zone))),
  ])
    .andThen(([str, datalog]) =>
      Result.combine(datalog.map((nightFiles) => importedFiles(nightFiles))).map((imported) => ({
        str,
        datalog,
        imported,
      })),
    )
    .map(({ str, datalog, imported }) => {
      const files = folderFiles(str, datalog.flat());
      const used = sorted.map((night) => usedDay(night, zone));
      const days = strDays(used);
      const rows = emptyRows(days);
      const firstImported = sorted.find((_night, i) => (datalog[i] ?? []).length > 0);

      rows.files.push(
        fileRow(
          files,
          { path: "Identification.tgt", kind: FileKind.Identification, night: null, segment: null },
          options.arrivedAt,
        ),
        fileRow(
          files,
          { path: "Identification.crc", kind: FileKind.Crc, night: null, segment: null },
          options.arrivedAt,
        ),
        fileRow(
          files,
          { path: "STR.edf", kind: FileKind.Str, night: null, segment: null },
          options.arrivedAt,
        ),
      );

      sorted.forEach((night, i) => {
        const nightFiles = datalog[i] ?? [];
        const day = used[i];

        if (nightFiles.length === 0 || day === undefined) {
          return;
        }

        addNight(rows, {
          night,
          day,
          zone,
          files: nightFiles,
          imported: imported[i] ?? [],
          folder: files,
          options,
        });
      });

      if (firstImported !== undefined) {
        rows.settings_changes.push(...settingsChanges(days, firstImported.night));
      }

      return { files, rows };
    });
}

// Builds the record that ingest reads from STR.edf for a night.
function usedDay(night: SyntheticNight, zone: string): UsedStrDay {
  return {
    day: night.night,
    used: true,
    ...maskSlots(night, zone),
    maskEvents: night.str["MaskEvents"],
    signals: Object.fromEntries(
      STR_NIGHT_COLUMNS.map(([label, column]) => [column, value(night.str[label])]),
    ),
    settings: Object.fromEntries(
      STR_SETTINGS.map(([label, setting]) => [setting, value(night.str[label])]),
    ),
  };
}

// Returns every day that STR.edf covers, from the first night to the last. Marks a day without a
// night as unused.
function strDays(used: readonly UsedStrDay[]): StrDay[] {
  const [first] = used;
  const last = used.at(-1);

  if (first === undefined || last === undefined) {
    return [];
  }

  const byDate = new Map(used.map((day) => [day.day.toString(), day]));

  return Array.from({ length: first.day.until(last.day).days + 1 }, (_, i): StrDay => {
    const day = first.day.add({ days: i });

    return byDate.get(day.toString()) ?? { day, used: false };
  });
}

function emptyRows(days: readonly StrDay[]): DerivedRows {
  return {
    device: [{ serial: DEVICE.serial, model: DEVICE.model }],
    daily_usage: days.map(({ day, ...record }) => ({
      day,
      usage: record.used ? (record.signals["usage"] ?? 0) : 0,
    })),
    settings_changes: [],
    nights: [],
    files: [],
    sessions: [],
    segments: [],
    events: [],
    samples: [],
    breaths: [],
  };
}

type FileSpec = Pick<FileRow, "path" | "kind" | "night" | "segment">;
// Maps each kind of file that ingest imports to its value in the `files` table's `kind` column.
const IMPORTED_KINDS = { brp: FileKind.Brp, pld: FileKind.Pld, eve: FileKind.Eve } as const;

/** Adds the file kind and size-check verdict to a night's file that ingest imports. */
type ImportedFile = DatalogFile & {
  kind: keyof typeof IMPORTED_KINDS;
  verdict: Exclude<FileSizeCheck["verdict"], "reject">;
};

function fileRow(folder: readonly CpapFile[], spec: FileSpec, ctime: Temporal.Instant): FileRow {
  const bytes = folder.find((file) => file.path === spec.path)?.bytes ?? new Uint8Array();

  return { ...spec, size: bytes.length, sha256: sha256(bytes), ctime };
}

type NightInputs = {
  night: SyntheticNight;
  day: UsedStrDay;
  files: readonly DatalogFile[];
  imported: readonly ImportedFile[];
  zone: string;
  folder: readonly CpapFile[];
  options: SynthesizeOptions;
};

// Ingest imports BRP, PLD, and EVE files that checkFileSize doesn't reject, and skips SAD and CSL.
const importedFiles = (files: readonly DatalogFile[]): Result<ImportedFile[], EdfReadError> =>
  Result.combine(
    files.map((file) =>
      sizeCheck(file).map(({ verdict }): ImportedFile[] =>
        (file.kind === "brp" || file.kind === "pld" || file.kind === "eve") && verdict !== "reject"
          ? [{ ...file, kind: file.kind, verdict }]
          : [],
      ),
    ),
  ).map((imported) => imported.flat());

// Adds one night's rows to every table that stores rows by night.
function addNight(
  rows: DerivedRows,
  { night, day, files, imported, zone, folder, options }: NightInputs,
): void {
  const date = night.night;
  const read = (kind: "brp" | "pld", i: number): ImportedFile[] =>
    imported.filter((file) => file.kind === kind && file.segment === i && file.verdict === "read");
  // Ingest makes a segment from each BRP file it reads.
  const segments = night.segments.flatMap((segment, i) => {
    const [brp] = read("brp", i);

    return brp === undefined ? [] : [{ segment, brp, plds: read("pld", i) }];
  });
  const built = buildSessions({
    night: date,
    zone,
    maskOn: day.maskOn,
    maskOff: day.maskOff,
    maskEvents: day.maskEvents,
    segments: segments.map(({ segment }) => segment),
  });
  // Returns the segment number of a BRP or PLD file that ingest read. Segment numbers start at 1,
  // as in the `segments` rows.
  const segmentOf = (file: ImportedFile): number | null => {
    const i = segments.findIndex(({ brp, plds }) => brp === file || plds.includes(file));

    return i === -1 ? null : i + 1;
  };

  const specs = imported.map((file): FileSpec => ({
    path: `${file.path}.edf`,
    kind: IMPORTED_KINDS[file.kind],
    night: date,
    segment: segmentOf(file),
  }));

  // Ingest imports the .crc of each BRP, PLD, and EVE file by size alone, even when it rejects the
  // file's EDF.
  const crcs = files.flatMap((file): FileSpec[] =>
    file.kind === "brp" || file.kind === "pld" || file.kind === "eve"
      ? [{ path: `${file.path}.crc`, kind: FileKind.Crc, night: date, segment: null }]
      : [],
  );

  rows.files.push(...[...specs, ...crcs].map((spec) => fileRow(folder, spec, options.arrivedAt)));

  rows.sessions.push(
    ...built.sessions.map(({ session, start, end, source }): SessionRow => ({
      night: date,
      session,
      ts: start,
      ended_at: end,
      source,
    })),
  );

  segments.forEach(({ segment, plds }, i) => {
    const session = built.sessionOfSegment[i] ?? 0;
    const index = i + 1;
    const { pldSeries } = segment;
    const pldStart = segment.start.add({ seconds: PLD_LAG_SECONDS });
    // shortcut: in every case, ingest reads all of a segment's PLD files or none of them; count
    // each file's own records if a case ever damages one half of a split PLD.
    const count = plds.length === 0 ? 0 : pldSeries["MaskPress.2s"].length;

    rows.segments.push({
      night: date,
      segment: index,
      session,
      ts: segment.start,
      ended_at: segment.end,
    } satisfies SegmentRow);

    for (let s = 0; s < count; s += 1) {
      const signals: SignalValues = Object.fromEntries(
        PLD_SAMPLE_COLUMNS.map(([label, column]) => [column, value(pldSeries[label][s])]),
      );

      rows.samples.push({
        night: date,
        segment: index,
        session,
        ts: pldStart.add({ seconds: PLD_SAMPLE_SECONDS * s }),
        signals,
      } satisfies SampleRow);
    }

    rows.breaths.push(
      ...breaths(segment, night).map((breath): BreathRow => ({
        night: date,
        segment: index,
        session,
        ts: segment.start.add({ milliseconds: Math.round(breath.start * 1000) }),
        duration: breath.inhale + breath.exhale,
        // A half-sine in-breath of this volume and length peaks at π × volume / (2 × length).
        amplitude: (Math.PI * breath.volume) / (2 * breath.inhale),
        inspiratory_volume: breath.volume,
      })),
    );
  });

  const events = eventRows(night, built.sessions);

  rows.events.push(...events);
  rows.nights.push({
    ...nightRow({ day, sessions: built, events, ruleSet: RULE_SETS[options.patient] }).row,
    arrived_at: options.arrivedAt,
  });
}

// Builds the event rows that ingest builds from the EVE files that `nightFiles` writes. `nightFiles`
// writes each event's end, in whole seconds, as the event's onset. An event starts at the start of
// its EVE file plus the rounded onset minus the event's written duration.
function eventRows(
  night: SyntheticNight,
  sessions: Parameters<typeof assignEvents>[1],
): EventRow[] {
  const starts = night.events.map((event) => {
    const file = eventFileFor(night, event.at);

    return file === undefined
      ? event.at
      : file.start.add({ seconds: eventOnset(file, event) - writtenDuration(event) });
  });
  const places = assignEvents(
    night.events.map((event, i) => {
      const start = starts[i] ?? event.at;

      return { start, end: start.add({ seconds: writtenDuration(event) }) };
    }),
    sessions,
  );

  return night.events.map((event, i) => ({
    night: night.night,
    session: places[i]?.session ?? null,
    ts: starts[i] ?? event.at,
    duration: writtenDuration(event) === 0 ? null : writtenDuration(event),
    type: event.type,
    label: EVENT_LABELS[event.type],
    source: EventSource.Resmed,
    outside_mask_on: places[i]?.outsideMaskOn ?? true,
  }));
}
