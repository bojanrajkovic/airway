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

/** `query.rows` takes the bucket and the group that a user clicked in a query's chart. */
export const BucketSelection = z.strictObject({
  spec: querySpec,
  /** The `bucket` value of the clicked series row. */
  bucket: z.union([Instant, PlainDate]),
  /** The group's value for each breakdown, in the order that the query lists its breakdowns. */
  breakdowns: z.array(cell),
});
export type BucketSelection = z.infer<typeof BucketSelection>;

/** `sql.run` takes one read-only SQL statement. */
export const SqlStatement = z.strictObject({ sql: z.string().trim().min(1) });

/** `links.resolve` takes a link's short code. */
export const LinkCode = z.strictObject({ code: ShortCode });

/**
 * `query.run` returns these links with its result. `link` is null when the explorer link would be
 * too long to use.
 */
type RunLinks = { link: string | null; shortLink: string };

/** `query.rows` returns up to 100 of a bucket's rows, oldest first and in display units. */
export type BucketRows = {
  columns: ResultColumn[];
  /** The web app opens the waveform viewer at a clicked row's `ts` and `night`. */
  rows: { ts: Temporal.Instant; night: Temporal.PlainDate; values: Cell[] }[];
  truncated: boolean;
};

/** A row of the `notes` table, which includes the note's author. */
export type Note = typeof notes.$inferSelect;

/** A finding's result, computed from the derived tables of one `derived_version`. */
export type Snapshot = { derivedVersion: number; ranAt: Temporal.Instant; result: SnapshotResult };

/**
 * `findings.get` returns a note, its short code, and its snapshots, sorted from the newest
 * `derived_version` to the oldest.
 */
export type Finding = { note: Note; shortCode: string; snapshots: Snapshot[] };

/** Describes one run in the history and the query that the run executed. */
export type HistoryEntryView = {
  id: number;
  shortCode: string;
  target: ShortLinkTarget;
  author: Author;
  ranAt: Temporal.Instant;
  rowCount: number;
  truncated: boolean;
};

/**
 * `history.list` returns one page of entries, newest first. Pass `before` to `history.list` to
 * fetch the next page. `before` is null on the last page.
 */
export type HistoryPage = { entries: HistoryEntryView[]; before: number | null };

/**
 * Lists every tRPC procedure under its final name, with its kind (query or mutation) and the zod
 * schema that validates its input. `input` is null when clients call the procedure without input.
 * A run that records history is a mutation because it writes a history entry.
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

/**
 * Maps each procedure to its return type. The server's types guarantee each output, so clients use
 * the output without validating it.
 */
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

/**
 * Maps each procedure to the type of input that a client sends. That type is the input type of the
 * procedure's zod schema, or void when `input` is null.
 */
export type ProcedureInputs = {
  [Name in ProcedureName]: (typeof PROCEDURES)[Name]["input"] extends z.ZodType
    ? z.input<(typeof PROCEDURES)[Name]["input"]>
    : // oxlint-disable-next-line typescript/no-invalid-void-type -- tRPC types a procedure without input as void
      void;
};
