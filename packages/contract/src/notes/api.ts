import { createInsertSchema } from "drizzle-zod";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { Instant, PlainDate } from "../dates.ts";
import type { QuerySpec } from "../query/spec.ts";
import { MAX_BODY_LENGTH, NOTE_CATEGORIES, notes, queryHistory } from "./schema.ts";

// The web app imports this file's types only, so drizzle stays out of the browser bundle.

/**
 * Checks a note's text. The text must contain a non-whitespace character and be at most
 * `MAX_BODY_LENGTH` characters long. The check counts characters as Postgres does, so an emoji
 * counts as one character, where JavaScript's `length` counts two.
 */
const Body = z
  .string()
  .regex(/\S/v, "is empty")
  // oxlint-disable-next-line typescript/no-misused-spread -- Postgres's char_length counts code points
  .refine((body) => [...body].length <= MAX_BODY_LENGTH, {
    error: `is longer than ${MAX_BODY_LENGTH.toLocaleString("en")} characters`,
  });

/** Validates the `{ id }` object that `/notes/<id>` and every note procedure accept. */
export const NoteId = z.strictObject({ id: z.number().int().positive() });

/** A short link's code is ten characters of lower-case Crockford base32. */
export const ShortCode = z.string().regex(/^[0-9a-hjkmnp-tv-z]{10}$/v, "isn't a short code");

/**
 * Lists the categories that a person or agent can choose when adding a note. Saving a finding is
 * the only way to create a `finding` note, because every `finding` note needs a query.
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
 * Validates the input of `notes.add` and MCP's `add_note`. The server sets the author, so the
 * schema rejects an input that has an author field. The database checks that the dates match
 * `datePrecision` and that each range is in order.
 */
export const AddNote = noteFields.strict();
export type AddNote = z.infer<typeof AddNote>;

/**
 * Validates the input of `notes.update`, which is the note's ID and the fields to change. The
 * database rejects an update that changes a finding note's category.
 */
export const UpdateNote = noteFields.partial().extend(NoteId.shape).strict();
export type UpdateNote = z.infer<typeof UpdateNote>;

/**
 * Validates the input of `notes.list` and MCP's `list_notes`. Each field that's set narrows the
 * list.
 */
export const ListNotes = z.strictObject({
  from: PlainDate.optional(),
  to: PlainDate.optional(),
  category: z.enum(NOTE_CATEGORIES).optional(),
});
export type ListNotes = z.infer<typeof ListNotes>;

/**
 * Validates the input of MCP's `save_finding`, which is the builder query's short code and the
 * finding's text.
 */
export const SaveFinding = z.strictObject({
  shortCode: ShortCode,
  body: Body,
});
export type SaveFinding = z.infer<typeof SaveFinding>;

/** A finding covers the nights from `firstNight` through `lastNight`, and its note shows both. */
export type FindingNights = { firstNight: Temporal.PlainDate; lastNight: Temporal.PlainDate };

/**
 * Returns the first and last night of a spec saved as a finding. Returns `relative_nights` for a
 * `last` range, because a finding re-runs its query and needs fixed dates.
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

/** `history.list` takes the previous page's `before` value and a page size. */
export const ListHistory = z.strictObject({
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListHistory = z.infer<typeof ListHistory>;

/** Validates one run for the server to record. The server adds the author and the time. */
export const HistoryEntry = createInsertSchema(queryHistory, { shortCode: ShortCode })
  .pick({ shortCode: true, rowCount: true, truncated: true })
  .strict();
export type HistoryEntry = z.infer<typeof HistoryEntry>;
