// One row type per derived table, keyed by column name, so the synthetic rows and ingest's writes
// share one shape. ddl.ts creates the tables.
import type { RuleSet } from "../profile.ts";
import type {
  AHI_CHECKS,
  EVENT_SOURCES,
  EVENT_TYPES,
  FILE_KINDS,
  SESSION_SOURCES,
} from "./values.ts";

/** Machine-signal columns, by column name. Null where the machine wrote no value. */
export type SignalValues = Readonly<Record<string, number | null>>;

export type DeviceRow = { serial: string; model: string };

export type ColumnUnitRow = {
  dataset: string;
  column_name: string;
  unit: string;
  decimals: number;
};

export type DailyUsageRow = { day: Temporal.PlainDate; usage: number };

export type SettingsChangeRow = {
  night: Temporal.PlainDate;
  setting: string;
  old_value: number | null;
  new_value: number | null;
};

/** `signals` holds the machine's STR.edf columns; the rest are airway's. */
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
  ahi_check: (typeof AHI_CHECKS)[number];
  rule_set: RuleSet;
  uploaded_at: Temporal.Instant;
};

export type FileRow = {
  path: string;
  kind: (typeof FILE_KINDS)[number];
  /** Null for STR.edf and Identification.tgt. */
  night: Temporal.PlainDate | null;
  size: number;
  sha256: string;
  ctime: Temporal.Instant;
};

export type SessionRow = {
  night: Temporal.PlainDate;
  session: number;
  ts: Temporal.Instant;
  ended_at: Temporal.Instant;
  source: (typeof SESSION_SOURCES)[number];
};

export type SegmentRow = {
  night: Temporal.PlainDate;
  segment: number;
  session: number;
  ts: Temporal.Instant;
  ended_at: Temporal.Instant;
  brp_path: string;
  pld_path: string | null;
};

export type EventRow = {
  night: Temporal.PlainDate;
  /** Null on a night with no sessions. */
  session: number | null;
  /** The event's start. */
  ts: Temporal.Instant;
  duration: number | null;
  type: (typeof EVENT_TYPES)[number];
  label: string | null;
  source: (typeof EVENT_SOURCES)[number];
  outside_mask_on: boolean;
};

/** `signals` holds PLD's columns. */
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
  /** Peak flow of the in-breath. */
  amplitude: number;
  inspiratory_volume: number;
};

/** Every derived table's rows, except `meta` and `period_percentiles`, which a load computes. */
export type DerivedRows = {
  device: DeviceRow[];
  column_units: ColumnUnitRow[];
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
