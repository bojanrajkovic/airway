import { z } from "zod";
import type { Author } from "../author.ts";
import { Instant, PlainDate } from "../dates.ts";
import { AddNote, ListHistory, ListNotes, NoteId, ShortCode, UpdateNote } from "../notes/api.ts";
import type { notes, SnapshotResult } from "../notes/schema.ts";
import type { ShortLinkTarget } from "../query/short-code.ts";
import { querySpec } from "../query/spec.ts";
import type { Cell, QueryResult, ResultColumn } from "./query.ts";
import type { SqlResult } from "./sql.ts";
import type { AppStatus } from "./status.ts";
import {
  NightRange,
  SummaryRange,
  type LastNightSummary,
  type RangeSummary,
  type SettingChange,
} from "./summary.ts";
import {
  WaveformNight,
  WaveformWindow,
  type WaveformData,
  type WaveformOverview,
} from "./waveform.ts";

const cell = z.union([z.number(), z.string(), z.boolean(), Instant, PlainDate, z.null()]);

/** What `query.rows` takes: a clicked bucket of a query's chart, in one group. */
export const BucketSelection = z.strictObject({
  spec: querySpec,
  /** Where the bucket starts, as the result's series row gives it. */
  bucket: z.union([Instant, PlainDate]),
  /** The group's breakdown values, in the query's breakdown order. */
  breakdowns: z.array(cell),
});
export type BucketSelection = z.infer<typeof BucketSelection>;

/** What `sql.run` takes: one read-only statement. */
export const SqlStatement = z.strictObject({ sql: z.string().trim().min(1) });

/** What `links.resolve` takes. */
export const LinkCode = z.strictObject({ code: ShortCode });

/** An explicit run's links. `link` is null when the explorer link would be too long to use. */
type RunLinks = { link: string | null; shortLink: string };

/** What `query.rows` returns: up to 100 of a bucket's rows, oldest first, in display units. */
export type BucketRows = {
  columns: ResultColumn[];
  /** Each row's moment and night, so a click can open the waveform viewer on it. */
  rows: { ts: Temporal.Instant; night: Temporal.PlainDate; values: Cell[] }[];
  truncated: boolean;
};

/** A note row, including its author. */
export type Note = typeof notes.$inferSelect;

/** A finding's result under one `derived_version`. */
export type Snapshot = { derivedVersion: number; ranAt: Temporal.Instant; result: SnapshotResult };

/** What `findings.get` returns. Snapshots are newest version first. */
export type Finding = { note: Note; shortCode: string; snapshots: Snapshot[] };

/** One query run from the history, with the query it ran. */
export type HistoryEntryView = {
  id: number;
  shortCode: string;
  target: ShortLinkTarget;
  author: Author;
  ranAt: Temporal.Instant;
  rowCount: number;
  truncated: boolean;
};

/** A page of history, newest first. `before` is what to pass for the next page, or null on the last. */
export type HistoryPage = { entries: HistoryEntryView[]; before: number | null };

/**
 * Every tRPC procedure under its final name: whether it's a query or a mutation, and the zod schema
 * its input must pass. A procedure that takes nothing has a null input. A run that records history
 * is a mutation, because it writes.
 *
 * The web app imports only this file's types. The notes inputs are built from the Drizzle tables,
 * so importing `PROCEDURES` as a value would put Drizzle in the browser bundle.
 */
export const PROCEDURES = {
  "query.run": { kind: "mutation", input: querySpec },
  "query.tile": { kind: "query", input: querySpec },
  "query.rows": { kind: "query", input: BucketSelection },
  "sql.run": { kind: "mutation", input: SqlStatement },
  "links.resolve": { kind: "query", input: LinkCode },
  "history.list": { kind: "query", input: ListHistory },
  "notes.list": { kind: "query", input: ListNotes },
  "notes.get": { kind: "query", input: NoteId },
  "notes.add": { kind: "mutation", input: AddNote },
  "notes.update": { kind: "mutation", input: UpdateNote },
  "notes.delete": { kind: "mutation", input: NoteId },
  "notes.restore": { kind: "mutation", input: NoteId },
  "findings.get": { kind: "query", input: NoteId },
  "findings.runNow": { kind: "mutation", input: NoteId },
  "summary.lastNight": { kind: "query", input: null },
  "summary.range": { kind: "query", input: SummaryRange },
  "summary.settingsChanges": { kind: "query", input: NightRange },
  "waveform.window": { kind: "query", input: WaveformWindow },
  "waveform.night": { kind: "query", input: WaveformNight },
  "app.status": { kind: "query", input: null },
} as const satisfies Record<string, { kind: "query" | "mutation"; input: z.ZodType | null }>;

export type ProcedureName = keyof typeof PROCEDURES;

/** What each procedure returns. The server's types guarantee it, so nothing checks it at runtime. */
export type ProcedureOutputs = {
  "query.run": QueryResult & RunLinks;
  "query.tile": QueryResult;
  "query.rows": BucketRows;
  "sql.run": SqlResult & { shortLink: string };
  "links.resolve": ShortLinkTarget;
  "history.list": HistoryPage;
  "notes.list": Note[];
  "notes.get": Note;
  "notes.add": Note;
  "notes.update": Note;
  // oxlint-disable-next-line typescript/no-invalid-void-type -- tRPC types a procedure that returns nothing as void
  "notes.delete": void;
  "notes.restore": Note;
  "findings.get": Finding;
  "findings.runNow": Snapshot;
  "summary.lastNight": LastNightSummary;
  "summary.range": RangeSummary;
  "summary.settingsChanges": SettingChange[];
  "waveform.window": WaveformData;
  "waveform.night": WaveformOverview;
  "app.status": AppStatus;
};

/** What a client sends each procedure: its schema's input type, or nothing. */
export type ProcedureInputs = {
  [Name in ProcedureName]: (typeof PROCEDURES)[Name]["input"] extends z.ZodType
    ? z.input<(typeof PROCEDURES)[Name]["input"]>
    : // oxlint-disable-next-line typescript/no-invalid-void-type -- tRPC types a procedure without input as void
      void;
};
