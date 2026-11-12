import { createInsertSchema } from "drizzle-zod";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { Instant, PlainDate } from "../dates.ts";
import type { QuerySpec } from "../query/spec.ts";
import { MAX_BODY_LENGTH, NOTE_CATEGORIES, notes, queryHistory } from "./schema.ts";

// The web app imports this file's types only, so drizzle stays out of the browser bundle.

/**
 * A note's text: something other than spaces, and at most `MAX_BODY_LENGTH` characters. It counts
 * characters as Postgres does, so an emoji counts once, not as its two UTF-16 units.
 */
const Body = z
  .string()
  .regex(/\S/v, "is empty")
  // oxlint-disable-next-line typescript/no-misused-spread -- code points are what Postgres's char_length counts
  .refine((body) => [...body].length <= MAX_BODY_LENGTH, {
    error: `is longer than ${MAX_BODY_LENGTH.toLocaleString("en")} characters`,
  });

/** A note's ID, as `/notes/<id>` and every note procedure take it. */
export const NoteId = z.strictObject({ id: z.number().int().positive() });

/** A short link's code: ten characters of lower-case Crockford base32. */
export const ShortCode = z.string().regex(/^[0-9a-hjkmnp-tv-z]{10}$/v, "isn't a short code");

/**
 * Every category a person or agent can add a note in. A `finding` note is made only by saving a
 * finding, because it needs its query.
 */
const WRITABLE_CATEGORIES = NOTE_CATEGORIES.filter((category) => category !== "finding");

const noteFields = createInsertSchema(notes, {
  firstNight: PlainDate,
  lastNight: PlainDate.nullish(),
  startsAt: Instant.nullish(),
  endsAt: Instant.nullish(),
  category: z.enum(WRITABLE_CATEGORIES),
  body: Body,
}).pick({
  firstNight: true,
  lastNight: true,
  datePrecision: true,
  startsAt: true,
  endsAt: true,
  category: true,
  body: true,
});

/**
 * What `notes.add` and MCP's `add_note` take. The server sets the author, so an input that names
 * one is rejected rather than ignored. The database checks how dates fit together.
 */
export const AddNote = noteFields.strict();
export type AddNote = z.infer<typeof AddNote>;

/**
 * What `notes.update` takes: the note's ID and the fields that change. A finding note keeps its
 * category; the database refuses to move it.
 */
export const UpdateNote = noteFields.partial().extend(NoteId.shape).strict();
export type UpdateNote = z.infer<typeof UpdateNote>;

/** What `notes.list` and MCP's `list_notes` take. Each field that's set narrows the list. */
export const ListNotes = z.strictObject({
  from: PlainDate.optional(),
  to: PlainDate.optional(),
  category: z.enum(NOTE_CATEGORIES).optional(),
});
export type ListNotes = z.infer<typeof ListNotes>;

/** What MCP's `save_finding` takes: the builder query's short code, and the finding's text. */
export const SaveFinding = z.strictObject({
  shortCode: ShortCode,
  body: Body,
});
export type SaveFinding = z.infer<typeof SaveFinding>;

/** The nights a finding covers, which its note shows. */
export type FindingNights = { firstNight: Temporal.PlainDate; lastNight: Temporal.PlainDate };

/**
 * The nights of a spec saved as a finding. A finding re-runs its query after a scoring change, so
 * the query must name its nights: `{last: 14}` would cover different nights on every run. A spec
 * with a `last` range fails with `relative_nights`; resolve it to dates first.
 */
export function findingNights(spec: QuerySpec): Result<FindingNights, "relative_nights"> {
  const { nights } = spec;

  return "last" in nights
    ? err("relative_nights")
    : ok({
        firstNight: Temporal.PlainDate.from(nights.from),
        lastNight: Temporal.PlainDate.from(nights.to),
      });
}

/** What `history.list` takes: a page of runs, newest first, older than `before` when it's set. */
export const ListHistory = z.strictObject({
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListHistory = z.infer<typeof ListHistory>;

/** One run, as the server records it. The server adds the author and the time. */
export const HistoryEntry = createInsertSchema(queryHistory, { shortCode: ShortCode })
  .pick({ shortCode: true, rowCount: true, truncated: true })
  .strict();
export type HistoryEntry = z.infer<typeof HistoryEntry>;
