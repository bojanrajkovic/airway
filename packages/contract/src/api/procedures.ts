import { z } from "zod";
import type { Author } from "../author.ts";
import { Instant, PlainDate } from "../dates.ts";
import { ShortCode } from "../notes/api.ts";
import type { notes, SnapshotResult } from "../notes/schema.ts";
import type { ShortLinkTarget } from "../query/short-code.ts";
import { querySpec } from "../query/spec.ts";
import type { Cell, ResultColumn } from "./query.ts";

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
export type RunLinks = { link: string | null; shortLink: string };

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
