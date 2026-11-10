import { RULE_SETS } from "../profile.ts";
import {
  AHI_CHECKS,
  EVENT_SOURCES,
  EVENT_TYPES,
  FILE_KINDS,
  PERCENTILE_SIGNALS,
  PERIODS,
  SESSION_SOURCES,
} from "./values.ts";

/**
 * Covers the derived tables' shapes and the scoring rules. Tables built under another version are
 * out of date. docs/scoring.md records what each version changed.
 */
export const DERIVED_VERSION = 1;

/** `derived` is the schema queries read. `derived_next` is where a replacement is built. */
export type DerivedSchema = "derived" | "derived_next";

/** The machine's nightly statistics from STR.edf, in the order the nights table holds them. */
export const NIGHT_SIGNALS = [
  "usage",
  "machine_on",
  "mask_events",
  "ahi",
  "hi",
  "ai",
  "oai",
  "cai",
  "uai",
  "rin",
  "csr",
  "mask_pressure_p50",
  "mask_pressure_p95",
  "mask_pressure_max",
  "target_ipap_p50",
  "target_ipap_p95",
  "target_ipap_max",
  "target_epap_p50",
  "target_epap_p95",
  "target_epap_max",
  "leak_p50",
  "leak_p70",
  "leak_p95",
  "leak_max",
  "minute_ventilation_p50",
  "minute_ventilation_p95",
  "minute_ventilation_max",
  "respiratory_rate_p50",
  "respiratory_rate_p95",
  "respiratory_rate_max",
  "tidal_volume_p50",
  "tidal_volume_p95",
  "tidal_volume_max",
  "ambient_humidity_p50",
  "humidifier_temperature_p50",
  "tube_temperature_p50",
  "humidifier_power_p50",
  "tube_power_p50",
] as const;
/** The 2 s signals from a PLD file, in the order the samples table holds them. */
export const SAMPLE_SIGNALS = [
  "mask_pressure",
  "pressure",
  "epr_pressure",
  "leak",
  "respiratory_rate",
  "tidal_volume",
  "minute_ventilation",
  "snore",
  "flow_limitation",
] as const;

const oneOf = (column: string, values: readonly string[]): string =>
  `check (${column} in (${values.map((value) => `'${value}'`).join(", ")}))`;
const doubles = (names: readonly string[]): string =>
  names.map((name) => `${name} double precision`).join(",\n  ");

/**
 * The statements that create every derived table in `schema`: all the derived DDL there is.
 *
 * The tables are UNLOGGED: they're rebuilt from the card's files, so they skip the WAL and
 * backups. Deleting a nights row removes that night from every table that holds a night's rows.
 */
export function derivedDdl(schema: DerivedSchema): string {
  return `
create schema ${schema};

create unlogged table ${schema}.meta (
  singleton boolean primary key default true check (singleton),
  derived_version integer not null,
  built_at timestamptz not null
);

create unlogged table ${schema}.device (
  serial text primary key,
  model text not null
);

-- One row per machine signal: the unit and decimals its EDF headers declare.
create unlogged table ${schema}.column_units (
  dataset text not null,
  column_name text not null,
  unit text not null,
  decimals smallint not null check (decimals between 0 and 6),
  primary key (dataset, column_name)
);

-- Every day STR.edf covers from the first imported night, used or not.
create unlogged table ${schema}.daily_usage (
  day date primary key,
  usage double precision not null
);

create unlogged table ${schema}.settings_changes (
  night date not null,
  setting text not null,
  old_value double precision,
  new_value double precision,
  primary key (night, setting)
);

create unlogged table ${schema}.period_percentiles (
  period text not null ${oneOf("period", PERIODS)},
  period_start date not null,
  signal text not null ${oneOf("signal", PERCENTILE_SIGNALS)},
  p50 double precision,
  p95 double precision,
  primary key (period, period_start, signal)
);

create unlogged table ${schema}.nights (
  night date primary key,
  -- The machine's own numbers, null when STR.edf has no usage for the night.
  ${doubles(NIGHT_SIGNALS)},
  -- airway's.
  sessions integer not null,
  expected_sessions integer not null,
  session_count_approximate boolean not null,
  longest_stretch double precision not null,
  obstructive_apneas integer not null,
  central_apneas integer not null,
  unclassified_apneas integer not null,
  hypopneas integer not null,
  arousals integer not null,
  events_outside_mask_on integer not null,
  ahi_check text not null ${oneOf("ahi_check", AHI_CHECKS)},
  rule_set text not null ${oneOf("rule_set", RULE_SETS)},
  uploaded_at timestamptz not null
);

-- STR.edf and Identification.tgt belong to no night.
create unlogged table ${schema}.files (
  path text primary key,
  kind text not null ${oneOf("kind", FILE_KINDS)},
  night date references ${schema}.nights on delete cascade,
  size bigint not null,
  sha256 text not null,
  ctime timestamptz not null
);

create unlogged table ${schema}.sessions (
  night date not null references ${schema}.nights on delete cascade,
  session smallint not null,
  ts timestamptz not null,
  ended_at timestamptz not null,
  source text not null ${oneOf("source", SESSION_SOURCES)},
  primary key (night, session)
);

create unlogged table ${schema}.segments (
  night date not null references ${schema}.nights on delete cascade,
  segment smallint not null,
  session smallint not null,
  ts timestamptz not null,
  ended_at timestamptz not null,
  brp_path text not null references ${schema}.files,
  pld_path text references ${schema}.files,
  primary key (night, segment),
  -- Lets samples and breaths reference a segment together with its session.
  unique (night, segment, session),
  foreign key (night, session) references ${schema}.sessions on delete cascade
);

-- A night with no sessions keeps its events, with no session.
create unlogged table ${schema}.events (
  night date not null references ${schema}.nights on delete cascade,
  session smallint,
  ts timestamptz not null,
  duration double precision,
  type text not null ${oneOf("type", EVENT_TYPES)},
  label text,
  source text not null ${oneOf("source", EVENT_SOURCES)},
  outside_mask_on boolean not null,
  foreign key (night, session) references ${schema}.sessions on delete cascade
);
create index events_night_ts on ${schema}.events (night, ts);

create unlogged table ${schema}.samples (
  night date not null,
  segment smallint not null,
  session smallint not null,
  ts timestamptz not null,
  ${doubles(SAMPLE_SIGNALS)},
  foreign key (night, segment, session) references ${schema}.segments (night, segment, session)
    on delete cascade
);
create index samples_night_ts on ${schema}.samples (night, ts);
-- "Latest samples" queries would otherwise scan the table.
create index samples_ts on ${schema}.samples (ts);
-- Feeds percentile_cont sorted values, one night at a time.
${PERCENTILE_SIGNALS.map((signal) => `create index samples_night_${signal} on ${schema}.samples (night, ${signal});`).join("\n")}

create unlogged table ${schema}.breaths (
  night date not null,
  segment smallint not null,
  session smallint not null,
  ts timestamptz not null,
  duration double precision not null,
  amplitude double precision not null,
  inspiratory_volume double precision not null,
  foreign key (night, segment, session) references ${schema}.segments (night, segment, session)
    on delete cascade
);
create index breaths_night_ts on ${schema}.breaths (night, ts);
`;
}
