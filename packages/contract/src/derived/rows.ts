// Defines one row type for each derived table, with fields named after the table's columns. The
// synthetic rows and the rows that ingest writes use these types, so both have the same shape.
// ddl.ts creates the tables.
import type { RuleSet } from "../profile.ts";
import type { AhiOutcome, EventSource, EventType, FileKind, SessionSource } from "./values.ts";

/**
 * Maps each machine-signal column's name to the column's value. The value is null when the machine
 * left the column empty.
 */
export type SignalValues = Readonly<Record<string, number | null>>;

export type DeviceRow = { serial: string; model: string };

export type DailyUsageRow = { day: Temporal.PlainDate; usage: number };

export type SettingsChangeRow = {
  night: Temporal.PlainDate;
  setting: string;
  old_value: number | null;
  new_value: number | null;
};

/** `signals` contains the machine's STR.edf columns. airway computes the other columns. */
export type NightRow = {
  night: Temporal.PlainDate;
  signals: SignalValues;
  sessions: number;
  expected_sessions: number;
  session_count_approximate: boolean;
  longest_stretch: number;
  obstructive_apneas: number;
  central_apneas: number;
  unclassified_apneas: number;
  hypopneas: number;
  arousals: number;
  events_outside_mask_on: number;
  ahi_check: AhiOutcome;
  rule_set: RuleSet;
  arrived_at: Temporal.Instant;
};

export type FileRow = {
  path: string;
  kind: FileKind;
  night: Temporal.PlainDate | null;
  segment: number | null;
  size: number;
  sha256: string;
  ctime: Temporal.Instant;
};

export type SessionRow = {
  night: Temporal.PlainDate;
  session: number;
  ts: Temporal.Instant;
  ended_at: Temporal.Instant;
  source: SessionSource;
};

export type SegmentRow = {
  night: Temporal.PlainDate;
  segment: number;
  session: number;
  ts: Temporal.Instant;
  ended_at: Temporal.Instant;
};

export type EventRow = {
  night: Temporal.PlainDate;
  session: number | null;
  /** `ts` is the event's start, or the event's end when `duration` is null. */
  ts: Temporal.Instant;
  duration: number | null;
  type: EventType;
  label: string | null;
  source: EventSource;
  outside_mask_on: boolean;
};

/** `signals` has each PLD signal's value at `ts`. */
export type SampleRow = {
  night: Temporal.PlainDate;
  segment: number;
  session: number;
  ts: Temporal.Instant;
  signals: SignalValues;
};

export type BreathRow = {
  night: Temporal.PlainDate;
  segment: number;
  session: number;
  ts: Temporal.Instant;
  duration: number;
  /** `amplitude` is the peak flow during the in-breath. */
  amplitude: number;
  inspiratory_volume: number;
};

/**
 * Groups the rows of every derived table by table name. The type omits `meta` and
 * `period_percentiles` because a load computes their rows.
 */
export type DerivedRows = {
  device: DeviceRow[];
  daily_usage: DailyUsageRow[];
  settings_changes: SettingsChangeRow[];
  nights: NightRow[];
  files: FileRow[];
  sessions: SessionRow[];
  segments: SegmentRow[];
  events: EventRow[];
  samples: SampleRow[];
  breaths: BreathRow[];
};
