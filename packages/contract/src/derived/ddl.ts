import { valuesOf } from "../enum.ts";
import { RULE_SETS } from "../profile.ts";
import type { Dataset } from "../registry/define.ts";
import { nights } from "../registry/nights.ts";
import { samples } from "../registry/samples.ts";
import {
  AhiOutcome,
  EventSource,
  EventType,
  FileKind,
  PercentileSignal,
  Period,
  SessionSource,
} from "./values.ts";

/**
 * Goes up when a derived table's shape or a scoring rule changes. Tables built under another
 * version are out of date. docs/scoring.md records what each version changed.
 */
export const DERIVED_VERSION = 1;

/** Queries read the `derived` schema. A replacement is built in `derived_next`. */
export type DerivedSchema = "derived" | "derived_next";

// Returns the names of the dataset's columns that ingest reads from EDF files.
const signals = ({ columns }: Dataset): string[] =>
  columns
    .filter((column) => column.role === "metric" && column.unit === "from_header")
    .map(({ name }) => name);

const oneOf = (column: string, values: readonly string[]): string =>
  `check (${column} in (${values.map((value) => `'${value}'`).join(", ")}))`;
const doubles = (names: readonly string[]): string =>
  names.map((name) => `${name} double precision`).join(",\n  ");

/**
 * Returns the statements that create `schema` and every derived table in it, without the indexes
 * and the two largest tables' foreign keys. `derivedIndexesAndKeys` returns the rest of the derived
 * DDL.
 *
 * The tables are UNLOGGED: they're rebuilt from the card's files, so they skip the WAL and
 * backups. Deleting a nights row removes that night from every table that holds a night's rows.
 */
export function derivedTables(schema: DerivedSchema): string {
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

-- Has a row for every day that STR.edf covers, starting at the first imported night, whether or
-- not the machine was used that day.
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
  period text not null ${oneOf("period", valuesOf(Period))},
  period_start date not null,
  signal text not null ${oneOf("signal", valuesOf(PercentileSignal))},
  p50 double precision,
  p95 double precision,
  primary key (period, period_start, signal)
);

create unlogged table ${schema}.nights (
  night date primary key,
  -- The machine's own numbers, null when STR.edf has no usage for the night.
  ${doubles(signals(nights))},
  -- The numbers that airway computes.
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
  ahi_check text not null ${oneOf("ahi_check", valuesOf(AhiOutcome))},
  rule_set text not null ${oneOf("rule_set", RULE_SETS)},
  arrived_at timestamptz not null
);

-- night is null for STR.edf and Identification.tgt.
create unlogged table ${schema}.files (
  path text primary key,
  kind text not null ${oneOf("kind", valuesOf(FileKind))},
  night date references ${schema}.nights on delete cascade,
  -- The segment that a BRP or PLD file's data belongs to. docs/data-model.md lists when it's null.
  segment smallint,
  size bigint not null,
  sha256 text not null,
  ctime timestamptz not null
);

create unlogged table ${schema}.sessions (
  night date not null references ${schema}.nights on delete cascade,
  session smallint not null,
  ts timestamptz not null,
  ended_at timestamptz not null,
  source text not null ${oneOf("source", valuesOf(SessionSource))},
  primary key (night, session)
);

create unlogged table ${schema}.segments (
  night date not null references ${schema}.nights on delete cascade,
  segment smallint not null,
  session smallint not null,
  ts timestamptz not null,
  ended_at timestamptz not null,
  primary key (night, segment),
  -- Lets samples and breaths reference a segment together with its session.
  unique (night, segment, session),
  foreign key (night, session) references ${schema}.sessions on delete cascade
);

-- session is null only on a night without sessions.
create unlogged table ${schema}.events (
  night date not null references ${schema}.nights on delete cascade,
  session smallint,
  ts timestamptz not null,
  duration double precision,
  type text not null ${oneOf("type", valuesOf(EventType))},
  label text,
  source text not null ${oneOf("source", valuesOf(EventSource))},
  outside_mask_on boolean not null,
  foreign key (night, session) references ${schema}.sessions on delete cascade
);

create unlogged table ${schema}.samples (
  night date not null,
  segment smallint not null,
  session smallint not null,
  ts timestamptz not null,
  ${doubles(signals(samples))}
);

create unlogged table ${schema}.breaths (
  night date not null,
  segment smallint not null,
  session smallint not null,
  ts timestamptz not null,
  duration double precision not null,
  amplitude double precision not null,
  inspiratory_volume double precision not null
);
`;
}

/**
 * Returns the statements that add the derived tables' indexes and the foreign keys from `samples`
 * and `breaths` to their segment. A load runs them after it has inserted its rows, because building
 * an index once is faster than updating it for every row, and adding a key checks every row in one
 * pass instead of one row at a time.
 */
export function derivedIndexesAndKeys(schema: DerivedSchema): string {
  return `
alter table ${schema}.files add foreign key (night, segment)
  references ${schema}.segments (night, segment);
${["samples", "breaths"].map((table) => `alter table ${schema}.${table} add foreign key (night, segment, session)\n  references ${schema}.segments (night, segment, session) on delete cascade;`).join("\n")}
create index events_night_ts on ${schema}.events (night, ts);
create index samples_night_ts on ${schema}.samples (night, ts);
-- "Latest samples" queries would otherwise scan the table.
create index samples_ts on ${schema}.samples (ts);
-- Feeds percentile_cont sorted values, one night at a time.
${valuesOf(PercentileSignal)
  .map((signal) => `create index samples_night_${signal} on ${schema}.samples (night, ${signal});`)
  .join("\n")}
create index breaths_night_ts on ${schema}.breaths (night, ts);
`;
}
