import { createHash } from "node:crypto";
import { Result } from "neverthrow";
import type { FileSizeCheck } from "@airway/edf/size";
import { offsetForNight, type ClockOffset } from "@airway/contract/clock";
import type {
  BreathRow,
  DerivedRows,
  EventRow,
  FileRow,
  NightRow,
  SampleRow,
  SegmentRow,
  SessionRow,
  SignalValues,
} from "@airway/contract/derived/rows";
import { assignEvents, buildSessions } from "@airway/contract/derived/sessions";
import { settingsChanges } from "@airway/contract/derived/settings";
import type { StrDay, UsedStrDay } from "@airway/contract/derived/str";
import {
  AIRSENSE,
  COLUMN_UNITS,
  dataSignals,
  PLD_SAMPLE_SECONDS,
  type EdfFileType,
} from "@airway/edf/airsense";
import type { RuleSet } from "@airway/contract/profile";
import { datalogFiles, folderFiles, type CpapFile, type DatalogFile } from "./cpap-data.ts";
import {
  DEVICE,
  EVENT_LABELS,
  eventFileFor,
  eventOnset,
  maskSlots,
  PLD_LAG_SECONDS,
  sizeCheck,
  strFile,
  type SyntheticFileError,
} from "./files.ts";
import type { SyntheticNight } from "./model.ts";
import { APNEAS, type Patient } from "./patients.ts";
import { breaths } from "./signals.ts";

export type SynthesizeOptions = {
  /** Sets each night's rule set: `pediatric` for a child, `adult` for an adult. */
  patient: Patient;
  /** Stands in for every time ingest takes from the import: file ctimes and `uploaded_at`. */
  uploadedAt: Temporal.Instant;
};

/** A CPAP data folder and the rows ingest should derive from it. */
export type Synthesized = { files: CpapFile[]; rows: DerivedRows };

const RULE_SETS: Readonly<Record<Patient, RuleSet>> = { child: "pediatric", adult: "adult" };

const value = (n: number | undefined): number | null =>
  n === undefined || Number.isNaN(n) ? null : n;

// The signals of `file` that fill a column of `table`, as [label, column] pairs.
const targets = (file: EdfFileType, table: "nights" | "samples"): [string, string][] =>
  dataSignals(file).flatMap((signal) =>
    signal.target.table === table ? [[signal.label, signal.target.column]] : [],
  );
const NIGHT_COLUMNS = targets(AIRSENSE.str, "nights");
const SAMPLE_COLUMNS = targets(AIRSENSE.pld, "samples");
const SETTINGS = dataSignals(AIRSENSE.str).flatMap((signal) =>
  signal.target.table === "settings" ? [[signal.label, signal.target.name] as const] : [],
);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The CPAP data folder for `nights`, and the rows ingest should derive from it. Both come from the
 * same inputs, so a test that edits a night gets files and rows that agree.
 *
 * A night with no segments has no folder, so ingest never sees it, and it gets only its
 * `daily_usage` row. The load fills `meta` and `period_percentiles`.
 */
export function synthesize(
  nights: readonly SyntheticNight[],
  offsets: readonly ClockOffset[],
  options: SynthesizeOptions,
): Result<Synthesized, SyntheticFileError> {
  const sorted = [...nights].sort((a, b) => Temporal.PlainDate.compare(a.night, b.night));

  return Result.combine([
    strFile(sorted, offsets),
    Result.combine(sorted.map((night) => datalogFiles(night, offsets))),
    Result.combine(
      sorted.map((night) =>
        offsetForNight(offsets, night.night).map((offset) => ({
          offset,
          day: usedDay(night, offset),
        })),
      ),
    ),
  ]).map(([str, datalog, used]) => {
    const files = folderFiles(str, datalog.flat());
    const days = strDays(used.map(({ day }) => day));
    const rows = emptyRows(days);
    const firstImported = sorted.find((_night, i) => (datalog[i] ?? []).length > 0);

    rows.files.push(
      fileRow(
        files,
        { path: "Identification.tgt", kind: "identification", night: null, segment: null },
        options.uploadedAt,
      ),
      fileRow(
        files,
        { path: "STR.edf", kind: "str", night: null, segment: null },
        options.uploadedAt,
      ),
    );

    sorted.forEach((night, i) => {
      const nightFiles = datalog[i] ?? [];
      const entry = used[i];

      if (nightFiles.length === 0 || entry === undefined) {
        return;
      }

      addNight(rows, { night, ...entry, files: nightFiles, folder: files, options });
    });

    if (firstImported !== undefined) {
      rows.settings_changes.push(...settingsChanges(days, firstImported.night));
    }

    return { files, rows };
  });
}

// A night's STR.edf record, as ingest reads it.
function usedDay(night: SyntheticNight, offset: ClockOffset): UsedStrDay {
  return {
    day: night.night,
    used: true,
    ...maskSlots(night, offset),
    maskEvents: night.str.get("MaskEvents") ?? 0,
    signals: Object.fromEntries(
      NIGHT_COLUMNS.map(([label, column]) => [column, value(night.str.get(label))]),
    ),
    settings: Object.fromEntries(
      SETTINGS.map(([label, setting]) => [setting, value(night.str.get(label))]),
    ),
  };
}

// Every day STR.edf covers, from the first night to the last. A day with no night is unused.
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
    column_units: [...COLUMN_UNITS],
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
/** A night's file that ingest imports. */
type ImportedFile = DatalogFile & {
  kind: "brp" | "pld" | "eve";
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
  offset: ClockOffset;
  folder: readonly CpapFile[];
  options: SynthesizeOptions;
};

// Adds one night's rows to every table that holds a night's rows.
function addNight(
  rows: DerivedRows,
  { night, day, files, offset, folder, options }: NightInputs,
): void {
  const date = night.night;
  // Ingest imports BRP, PLD, and EVE files that checkFileSize doesn't reject, and skips SAD and CSL.
  const imported = files.flatMap((file): ImportedFile[] => {
    const { verdict } = sizeCheck(file);

    return (file.kind === "brp" || file.kind === "pld" || file.kind === "eve") &&
      verdict !== "reject"
      ? [{ ...file, kind: file.kind, verdict }]
      : [];
  });
  const read = (kind: "brp" | "pld", i: number): ImportedFile[] =>
    imported.filter((file) => file.kind === kind && file.segment === i && file.verdict === "read");
  // Ingest makes a segment from each BRP file it reads.
  const segments = night.segments.flatMap((segment, i) => {
    const [brp] = read("brp", i);

    return brp === undefined ? [] : [{ segment, brp, plds: read("pld", i) }];
  });
  const built = buildSessions({
    night: date,
    offset,
    maskOn: day.maskOn,
    maskOff: day.maskOff,
    maskEvents: day.maskEvents,
    segments: segments.map(({ segment }) => segment),
  });
  // A read BRP or PLD file names its segment, numbered from 1 like the segments rows.
  const segmentOf = (file: ImportedFile): number | null => {
    const i = segments.findIndex(({ brp, plds }) => brp === file || plds.includes(file));

    return i === -1 ? null : i + 1;
  };

  const specs = imported.map((file): FileSpec => ({
    path: `${file.path}.edf`,
    kind: file.kind,
    night: date,
    segment: segmentOf(file),
  }));

  rows.files.push(...specs.map((spec) => fileRow(folder, spec, options.uploadedAt)));

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
    const session = built.segmentSessions[i] ?? 0;
    const index = i + 1;
    const { pldSeries } = segment;
    const pldStart = segment.start.add({ seconds: PLD_LAG_SECONDS });
    // shortcut: a segment's PLD files all read or none do, which every case holds; count each
    // file's own records if a case ever damages one half of a split PLD.
    const count =
      plds.length === 0 ? 0 : (pldSeries.get(SAMPLE_COLUMNS[0]?.[0] ?? "")?.length ?? 0);

    rows.segments.push({
      night: date,
      segment: index,
      session,
      ts: segment.start,
      ended_at: segment.end,
    } satisfies SegmentRow);

    for (let s = 0; s < count; s += 1) {
      const signals: SignalValues = Object.fromEntries(
        SAMPLE_COLUMNS.map(([label, column]) => [column, value(pldSeries.get(label)?.[s])]),
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
  rows.nights.push(nightRow(night, built, events, options));
}

// Events as ingest reads them from EVE: the onset is written in whole seconds at the event's end,
// so an event starts at its EVE file's start, plus the rounded onset, minus its duration.
function eventRows(
  night: SyntheticNight,
  sessions: Parameters<typeof assignEvents>[1],
): EventRow[] {
  const starts = night.events.map((event) => {
    const file = eventFileFor(night, event.at);

    return file === undefined
      ? event.at
      : file.start.add({ seconds: eventOnset(file, event) - event.duration });
  });
  const places = assignEvents(
    night.events.map((event, i) => {
      const start = starts[i] ?? event.at;

      return { start, end: start.add({ seconds: event.duration }) };
    }),
    sessions,
  );

  return night.events.map((event, i) => ({
    night: night.night,
    session: places[i]?.session ?? null,
    ts: starts[i] ?? event.at,
    duration: event.duration,
    type: event.type,
    label: EVENT_LABELS[event.type],
    source: "resmed",
    outside_mask_on: places[i]?.outsideMaskOn ?? true,
  }));
}

function nightRow(
  night: SyntheticNight,
  built: ReturnType<typeof buildSessions>,
  events: readonly EventRow[],
  { patient, uploadedAt }: SynthesizeOptions,
): NightRow {
  const count = (type: EventRow["type"]): number => events.filter((e) => e.type === type).length;
  const usage = night.str.get("OnDuration") ?? 0;
  const ahi = night.str.get("AHI") ?? Number.NaN;
  const scored = events.filter((e) => APNEAS.has(e.type) || e.type === "hypopnea").length;
  const ahiCheck: NightRow["ahi_check"] =
    usage > 0
      ? Math.floor((600 * scored) / usage) === Math.round(ahi * 10)
        ? "match"
        : "mismatch"
      : "no_usage";

  return {
    night: night.night,
    signals: Object.fromEntries(
      NIGHT_COLUMNS.map(([label, column]) => [column, value(night.str.get(label))]),
    ),
    sessions: built.sessions.length,
    expected_sessions: Math.floor((night.str.get("MaskEvents") ?? 0) / 2),
    session_count_approximate: built.approximate,
    longest_stretch: Math.max(
      0,
      ...built.sessions.map(({ start, end }) => start.until(end).total("minutes")),
    ),
    obstructive_apneas: count("obstructive_apnea"),
    central_apneas: count("central_apnea"),
    unclassified_apneas: count("unclassified_apnea"),
    hypopneas: count("hypopnea"),
    arousals: count("arousal"),
    events_outside_mask_on: events.filter((e) => e.outside_mask_on).length,
    ahi_check: ahiCheck,
    rule_set: RULE_SETS[patient],
    uploaded_at: uploadedAt,
  };
}
