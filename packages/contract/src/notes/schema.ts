import { sql, type Column, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AgentResult } from "../api/agent.ts";
import { CHANNELS } from "../author.ts";
import type { QuerySpecInput } from "../query/spec.ts";
import { instant, plainDate } from "./columns.ts";

/** What a note is about. A `finding` note also has a row in `findings`. */
export const NOTE_CATEGORIES = [
  "procedure",
  "study",
  "medication",
  "illness",
  "equipment",
  "finding",
  "other",
] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

/** How precisely a note's dates are known. */
export const DATE_PRECISIONS = ["day", "month", "year"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/** The kinds of query a short link opens. */
export const SHORT_LINK_KINDS = ["spec", "sql"] as const;

/** The longest note body, in characters. */
export const MAX_BODY_LENGTH = 32_000;

// The lists are our own constants, never input, so they go into the DDL as literals.
const oneOf = (column: Column, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

/**
 * The person and channel behind a request, as notes and history store them. A function, because
 * each table needs its own column builders.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type -- drizzle infers these columns' types; writing them out would repeat them
const authorColumns = () => ({
  authorEmail: text("author_email").notNull(),
  authorName: text("author_name").notNull(),
  authorChannel: text("author_channel", { enum: CHANNELS }).notNull(),
});

export const notesSchema = pgSchema("notes");

/**
 * Everything written about one or more nights. Deleting a note sets `deletedAt`; nothing is ever
 * purged, so a delete can be undone.
 */
export const notes = notesSchema.table(
  "notes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    firstNight: plainDate("first_night").notNull(),
    lastNight: plainDate("last_night"),
    datePrecision: text("date_precision", { enum: DATE_PRECISIONS }).notNull().default("day"),
    startsAt: instant("starts_at"),
    endsAt: instant("ends_at"),
    category: text("category", { enum: NOTE_CATEGORIES }).notNull(),
    body: text("body").notNull(),
    ...authorColumns(),
    createdAt: instant("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: instant("updated_at"),
    updatedByEmail: text("updated_by_email"),
    updatedByName: text("updated_by_name"),
    deletedAt: instant("deleted_at"),
  },
  (table) => [
    // The findings foreign key points at (id, category), so a finding can only reference a
    // finding note.
    unique("notes_id_category").on(table.id, table.category),
    check("notes_category", oneOf(table.category, NOTE_CATEGORIES)),
    check("notes_author_channel", oneOf(table.authorChannel, CHANNELS)),
    check("notes_date_precision", oneOf(table.datePrecision, DATE_PRECISIONS)),
    // A month is stored as its 1st and a year as 1 January, so sorting and range filters work.
    // Truncating to `day` changes nothing, so day precision allows any date.
    check(
      "notes_dates_match_precision",
      sql`${table.firstNight} = date_trunc(${table.datePrecision}, ${table.firstNight}::timestamp)::date
        and (${table.lastNight} is null
          or ${table.lastNight} = date_trunc(${table.datePrecision}, ${table.lastNight}::timestamp)::date)`,
    ),
    check("notes_last_night_order", sql`${table.lastNight} >= ${table.firstNight}`),
    // A time range needs both ends, in order, and only on a note dated to the day.
    check(
      "notes_time_range",
      sql`(${table.startsAt} is null and ${table.endsAt} is null)
        or (${table.startsAt} is not null and ${table.endsAt} is not null
          and ${table.startsAt} < ${table.endsAt} and ${table.datePrecision} = 'day')`,
    ),
    // A body has some text, and no more than the limit.
    check(
      "notes_body_length",
      sql`${table.body} ~ '[^[:space:]]'
        and char_length(${table.body}) <= ${sql.raw(String(MAX_BODY_LENGTH))}`,
    ),
    check(
      "notes_updated_together",
      sql`(${table.updatedAt} is null) = (${table.updatedByEmail} is null)
        and (${table.updatedAt} is null) = (${table.updatedByName} is null)`,
    ),
  ],
);

/**
 * Every builder query or SQL statement anyone linked to, keyed by its short code. Each row holds a
 * canonical spec or SQL text, matching its kind.
 */
export const shortLinks = notesSchema.table(
  "short_links",
  {
    code: text("code").primaryKey(),
    kind: text("kind", { enum: SHORT_LINK_KINDS }).notNull(),
    spec: jsonb("spec").$type<QuerySpecInput>(),
    sql: text("sql"),
    createdAt: instant("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    check(
      "short_links_content_matches_kind",
      sql`(${table.kind} = 'spec' and ${table.spec} is not null and ${table.sql} is null)
        or (${table.kind} = 'sql' and ${table.sql} is not null and ${table.spec} is null)`,
    ),
  ],
);

/**
 * The query behind a finding note. `category` is always `finding`; it exists so the foreign key
 * can require the note to be in that category.
 */
export const findings = notesSchema.table(
  "findings",
  {
    noteId: bigint("note_id", { mode: "number" }).primaryKey(),
    category: text("category", { enum: ["finding"] })
      .notNull()
      .default("finding"),
    shortCode: text("short_code")
      .notNull()
      .references(() => shortLinks.code),
  },
  (table) => [
    check("findings_category", sql`${table.category} = 'finding'`),
    foreignKey({
      name: "findings_note",
      columns: [table.noteId, table.category],
      foreignColumns: [notes.id, notes.category],
    }),
  ],
);

/** A finding's result rows, capped the way agent results are. */
export type SnapshotResult = Pick<AgentResult, "columns" | "rows" | "truncated">;

/**
 * A finding's result under one `derived_version`. Run now replaces the current version's row, and
 * older versions' rows stay for comparison.
 */
export const findingSnapshots = notesSchema.table(
  "finding_snapshots",
  {
    noteId: bigint("note_id", { mode: "number" })
      .notNull()
      .references(() => findings.noteId),
    derivedVersion: integer("derived_version").notNull(),
    ranAt: instant("ran_at").notNull(),
    result: jsonb("result").$type<SnapshotResult>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.derivedVersion] })],
);

/** Each explicit run: the explorer's Run, opening a link, or an MCP tool call. Never pruned. */
export const queryHistory = notesSchema.table(
  "query_history",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shortCode: text("short_code")
      .notNull()
      .references(() => shortLinks.code),
    ...authorColumns(),
    ranAt: instant("ran_at")
      .notNull()
      .default(sql`now()`),
    rowCount: integer("row_count").notNull(),
    truncated: boolean("truncated").notNull(),
  },
  (table) => [
    check("query_history_author_channel", oneOf(table.authorChannel, CHANNELS)),
    check("query_history_row_count", sql`${table.rowCount} >= 0`),
  ],
);
