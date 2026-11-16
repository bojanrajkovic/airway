import { createHash } from "node:crypto";
import { Result } from "neverthrow";
import { offsetForNight, type ClockOffset } from "@airway/contract/clock";
import type {
  BreathRow,
  ColumnUnitRow,
  DerivedRows,
  EventRow,
  FileRow,
  NightRow,
  SampleRow,
  SegmentRow,
  SessionRow,
  SettingsChangeRow,
  SignalValues,
} from "@airway/contract/derived/rows";
import { assignEvents, buildSessions } from "@airway/contract/derived/sessions";
import { AIRSENSE, dataSignals, step, type EdfFile } from "@airway/contract/edf/airsense";
import type { RuleSet } from "@airway/contract/profile";
import { decimalsForStep } from "@airway/contract/registry/units";
import { datalogFiles, folderFiles, type CpapFile, type DatalogFile } from "./cpap-data.ts";
import { DEVICE, EVENT_LABELS, maskSlots, strFile, type SyntheticFileError } from "./files.ts";
import type { SyntheticNight } from "./model.ts";
import type { Patient } from "./patients.ts";
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
const APNEAS = new Set(["obstructive_apnea", "central_apnea", "unclassified_apnea"]);
// PLD files start this long after their BRP file.
const PLD_LAG_SECONDS = 1;
const PLD_SECONDS = 2;

const value = (n: number | undefined): number | null =>
  n === undefined || Number.isNaN(n) ? null : n;

// The signals of `file` that fill a column of `table`, as [label, column] pairs.
const targets = (file: EdfFile, table: "nights" | "samples"): [string, string][] =>
  dataSignals(file).flatMap((signal) =>
    signal.target.table === table ? [[signal.label, signal.target.column]] : [],
  );
const NIGHT_COLUMNS = targets(AIRSENSE.str, "nights");
const SAMPLE_COLUMNS = targets(AIRSENSE.pld, "samples");
const SETTINGS = dataSignals(AIRSENSE.str).flatMap((signal) =>
  signal.target.table === "settings" ? [[signal.label, signal.target.name] as const] : [],
);

/**
 * Each machine signal's unit and decimals, as ingest records them from the headers. A breath's
 * amplitude and volume come from the 25 Hz flow signal, so they take its decimals.
 */
function columnUnits(): ColumnUnitRow[] {
  const fromFile = (file: EdfFile, dataset: "nights" | "samples"): ColumnUnitRow[] =>
    dataSignals(file).flatMap((signal) =>
      signal.target.table === dataset
        ? [
            {
              dataset,
              column_name: signal.target.column,
              unit: signal.unit,
              decimals: decimalsForStep(step(signal)),
            },
          ]
        : [],
    );
  const flow = AIRSENSE.brp.signals.find((signal) => signal.label === "Flow.40ms");
  const flowDecimals = flow === undefined ? 3 : decimalsForStep(step(flow));

  return [
    ...fromFile(AIRSENSE.str, "nights"),
    ...fromFile(AIRSENSE.pld, "samples"),
    {
      dataset: "breaths",
      column_name: "amplitude",
      unit: flow?.unit ?? "L/s",
      decimals: flowDecimals,
    },
    { dataset: "breaths", column_name: "inspiratory_volume", unit: "L", decimals: flowDecimals },
  ];
}

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
    Result.combine(sorted.map((night) => offsetForNight(offsets, night.night))),
  ]).map(([str, datalog, nightOffsets]) => {
    const files = folderFiles(str, datalog.flat());
    const rows = emptyRows(sorted);
    let previous: SyntheticNight | undefined = undefined;

    rows.files.push(
      fileRow(
        files,
        { path: "Identification.tgt", kind: "identification", night: null },
        options.uploadedAt,
      ),
      fileRow(files, { path: "STR.edf", kind: "str", night: null }, options.uploadedAt),
    );

    sorted.forEach((night, i) => {
      const nightFiles = datalog[i] ?? [];
      const offset = nightOffsets[i];

      if (nightFiles.length === 0 || offset === undefined) {
        return;
      }

      addNight(rows, { night, files: nightFiles, offset, folder: files, options });
      rows.settings_changes.push(...settingsChanges(previous, night));
      previous = night;
    });

    return { files, rows };
  });
}

function emptyRows(nights: readonly SyntheticNight[]): DerivedRows {
  const [first] = nights;
  const last = nights.at(-1);
  const byDate = new Map(nights.map((night) => [night.night.toString(), night]));
  const days =
    first === undefined || last === undefined ? 0 : first.night.until(last.night).days + 1;

  return {
    device: [{ serial: DEVICE.serial, model: DEVICE.model }],
    column_units: columnUnits(),
    // Every day STR.edf covers. An unused day has no night and no usage.
    daily_usage: Array.from({ length: days }, (_, i) => {
      const day = (first?.night ?? Temporal.PlainDate.from("2030-01-01")).add({ days: i });

      return { day, usage: value(byDate.get(day.toString())?.str.get("OnDuration")) ?? 0 };
    }),
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

type FileSpec = Pick<FileRow, "path" | "kind" | "night">;

function fileRow(folder: readonly CpapFile[], spec: FileSpec, ctime: Temporal.Instant): FileRow {
  const bytes = folder.find((file) => file.path === spec.path)?.bytes ?? new Uint8Array();

  return { ...spec, size: bytes.length, sha256: sha256(bytes), ctime };
}

type NightInputs = {
  night: SyntheticNight;
  files: readonly DatalogFile[];
  offset: ClockOffset;
  folder: readonly CpapFile[];
  options: SynthesizeOptions;
};

// Adds one night's rows to every table that holds a night's rows.
function addNight(rows: DerivedRows, { night, files, offset, folder, options }: NightInputs): void {
  const date = night.night;
  const maskEvents = night.str.get("MaskEvents") ?? 0;
  const built = buildSessions({
    night: date,
    offset,
    ...maskSlots(night, offset),
    maskEvents,
    segments: night.segments,
  });
  const brps = files.filter((file) => file.kind === "brp");
  const plds = files.filter((file) => file.kind === "pld");
  const eve = files.find((file) => file.kind === "eve");

  // Ingest imports BRP, PLD, and EVE files, and skips SAD and CSL.
  const imported: FileSpec[] = [
    ...brps.map((file): FileSpec => ({ path: `${file.path}.edf`, kind: "brp", night: date })),
    ...plds.map((file): FileSpec => ({ path: `${file.path}.edf`, kind: "pld", night: date })),
    ...(eve === undefined ? [] : [{ path: `${eve.path}.edf`, kind: "eve" as const, night: date }]),
  ];

  rows.files.push(...imported.map((spec) => fileRow(folder, spec, options.uploadedAt)));

  rows.sessions.push(
    ...built.sessions.map(({ session, start, end, source }): SessionRow => ({
      night: date,
      session,
      ts: start,
      ended_at: end,
      source,
    })),
  );

  night.segments.forEach((segment, i) => {
    const session = built.segmentSessions[i] ?? 0;
    const index = i + 1;
    const { pld } = segment;
    const pldStart = segment.start.add({ seconds: PLD_LAG_SECONDS });
    const count = pld.get(SAMPLE_COLUMNS[0]?.[0] ?? "")?.length ?? 0;

    rows.segments.push({
      night: date,
      segment: index,
      session,
      ts: segment.start,
      ended_at: segment.end,
      brp_path: `${brps[i]?.path ?? ""}.edf`,
      pld_path: plds[i] === undefined ? null : `${plds[i].path}.edf`,
    } satisfies SegmentRow);

    for (let s = 0; s < count; s += 1) {
      const signals: SignalValues = Object.fromEntries(
        SAMPLE_COLUMNS.map(([label, column]) => [column, value(pld.get(label)?.[s])]),
      );

      rows.samples.push({
        night: date,
        segment: index,
        session,
        ts: pldStart.add({ seconds: PLD_SECONDS * s }),
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
// so an event starts at the recording start, plus the rounded onset, minus its duration.
function eventRows(
  night: SyntheticNight,
  sessions: Parameters<typeof assignEvents>[1],
): EventRow[] {
  const recordingStart = night.segments[0]?.start;

  if (recordingStart === undefined) {
    return [];
  }

  const starts = night.events.map((event) => {
    const onset = Math.round(recordingStart.until(event.at).total("seconds") + event.duration);

    return recordingStart.add({ seconds: onset - event.duration });
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

// A row for each setting that differs from the previous imported night.
function settingsChanges(
  previous: SyntheticNight | undefined,
  night: SyntheticNight,
): SettingsChangeRow[] {
  if (previous === undefined) {
    return [];
  }

  return SETTINGS.flatMap(([label, setting]): SettingsChangeRow[] => {
    const before = value(previous.str.get(label));
    const after = value(night.str.get(label));

    return before === after
      ? []
      : [{ night: night.night, setting, old_value: before, new_value: after }];
  });
}
