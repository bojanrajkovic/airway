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
import { valuesOf } from "../enum.ts";
import type { AgentResult } from "../api/agent.ts";
import { Channel } from "../author.ts";
import type { QuerySpecInput } from "../query/spec.ts";
import { instant, plainDate } from "./columns.ts";
import { DatePrecision, NoteCategory, ShortLinkKind } from "./values.ts";

/** A note's body can be at most this many characters long. */
export const MAX_BODY_LENGTH = 32_000;

// Callers pass only our own constants, so `oneOf` writes the values into the DDL as literals.
const oneOf = (column: Column, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

/**
 * Returns the columns that record who made a request and through which channel, for `notes` and
 * `query_history`. `authorColumns` is a function because each table needs its own column builders.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type -- drizzle infers these columns' types; writing them out would repeat them
const authorColumns = () => ({
  authorEmail: text("author_email").notNull(),
  authorName: text("author_name").notNull(),
  authorChannel: text("author_channel", { enum: valuesOf(Channel) }).notNull(),
});

export const notesSchema = pgSchema("notes");

/**
 * Each row is a note about one or more nights. Deleting a note only sets `deletedAt` and keeps the
 * row, so a delete can be undone.
 */
export const notes = notesSchema.table(
  "notes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    firstNight: plainDate("first_night").notNull(),
    lastNight: plainDate("last_night"),
    datePrecision: text("date_precision", { enum: valuesOf(DatePrecision) })
      .notNull()
      .default(DatePrecision.Day),
    startsAt: instant("starts_at"),
    endsAt: instant("ends_at"),
    category: text("category", { enum: valuesOf(NoteCategory) }).notNull(),
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
    // The findings foreign key points at (id, category), so a finding can reference only a
    // finding note.
    unique("notes_id_category").on(table.id, table.category),
    check("notes_category", oneOf(table.category, valuesOf(NoteCategory))),
    check("notes_author_channel", oneOf(table.authorChannel, valuesOf(Channel))),
    check("notes_date_precision", oneOf(table.datePrecision, valuesOf(DatePrecision))),
    // Each night must be the first day of its period, such as the 1st for `month`, so that sorting
    // and range filters work.
    check(
      "notes_dates_match_precision",
      sql`${table.firstNight} = date_trunc(${table.datePrecision}, ${table.firstNight}::timestamp)::date
        and (${table.lastNight} is null
          or ${table.lastNight} = date_trunc(${table.datePrecision}, ${table.lastNight}::timestamp)::date)`,
    ),
    check("notes_last_night_order", sql`${table.lastNight} >= ${table.firstNight}`),
    // A time range needs a start and a later end, and only a note with day precision can have a
    // time range.
    check(
      "notes_time_range",
      sql`(${table.startsAt} is null and ${table.endsAt} is null)
        or (${table.startsAt} is not null and ${table.endsAt} is not null
          and ${table.startsAt} < ${table.endsAt} and ${table.datePrecision} = 'day')`,
    ),
    // A body contains a non-whitespace character and is at most `MAX_BODY_LENGTH` characters long.
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
 * Stores every builder query and SQL statement that someone has linked to, keyed by short code. A
 * `spec` row stores a canonical spec, and a `sql` row stores SQL text.
 */
export const shortLinks = notesSchema.table(
  "short_links",
  {
    code: text("code").primaryKey(),
    kind: text("kind", { enum: valuesOf(ShortLinkKind) }).notNull(),
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
 * Links each finding note to the short link for its query. `category` is always `finding`. The
 * column exists so the foreign key can require a note in the `finding` category.
 */
export const findings = notesSchema.table(
  "findings",
  {
    noteId: bigint("note_id", { mode: "number" }).primaryKey(),
    category: text("category", { enum: [NoteCategory.Finding] })
      .notNull()
      .default(NoteCategory.Finding),
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

/** A snapshot stores a finding's result rows, truncated at the same limit as an agent result. */
export type SnapshotResult = Pick<AgentResult, "columns" | "rows" | "truncated">;

/**
 * Each row stores a finding's result under one `derived_version`. "Run now" replaces the row for
 * the current version and leaves the rows for older versions, so the results can be compared.
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

/**
 * Records every query that someone runs by clicking Run in the explorer, opening a link, or calling
 * an MCP tool. The rows stay forever.
 */
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
    check("query_history_author_channel", oneOf(table.authorChannel, valuesOf(Channel))),
    check("query_history_row_count", sql`${table.rowCount} >= 0`),
  ],
);
