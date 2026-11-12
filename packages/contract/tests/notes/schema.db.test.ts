import { fileURLToPath } from "node:url";
import { test } from "@airway/testing/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describe, expect } from "vitest";
import {
  findings,
  findingSnapshots,
  notes,
  queryHistory,
  shortLinks,
} from "../../src/notes/schema.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const author = { authorEmail: "a@example.com", authorName: "Alex", authorChannel: "web" } as const;
const note = {
  firstNight: Temporal.PlainDate.from("2030-01-10"),
  category: "other",
  body: "Synthetic note.",
  ...author,
} as const;
const link = { code: "0123456789", kind: "sql", sql: "select 1" } as const;

// One pool and one migrated database serve the whole file.
const migrated = test.extend<{ db: NodePgDatabase }>({
  db: [
    async ({ databaseUrl }, use) => {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      const db = drizzle({ client: pool });

      try {
        await migrate(db, { migrationsFolder: MIGRATIONS });
        await use(db);
      } finally {
        await pool.end();
      }
    },
    { scope: "file" },
  ],
});

// Each test runs in a transaction that rolls back, so tests don't see each other's rows.
class Rollback extends Error {}
async function inRollback(
  db: NodePgDatabase,
  run: (tx: NodePgDatabase) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await run(tx);

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  }
}

/** The constraint a write broke, read from the Postgres error drizzle wraps. */
async function brokenConstraint(write: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await write;
  } catch (error) {
    if (error instanceof Error && error.cause instanceof pg.DatabaseError) {
      return error.cause.constraint;
    }

    throw error;
  }

  return undefined;
}

/** Adds a note and returns its ID. */
async function addNote(db: NodePgDatabase, values: typeof notes.$inferInsert): Promise<number> {
  const [row] = await db.insert(notes).values(values).returning({ id: notes.id });

  if (row === undefined) {
    throw new Error("the insert returned no row");
  }

  return row.id;
}

migrated("migrate() creates the notes tables", async ({ db }) => {
  const { rows } = await db.execute<{ name: string }>(
    `select relname as name from pg_class
     where relnamespace = 'notes'::regnamespace and relkind = 'r' order by relname`,
  );

  expect(rows.map(({ name }) => name)).toEqual([
    "finding_snapshots",
    "findings",
    "notes",
    "query_history",
    "short_links",
  ]);
});

// Postgres writes a timestamp's offset in the session's time zone, such as -05, so the column
// has to read more than UTC's +00.
migrated.for(["UTC", "America/New_York"])(
  "Instants and PlainDates round-trip through their columns, with the session in %s",
  async (zone, { db }) => {
    const startsAt = Temporal.Instant.from("2030-01-10T03:15:30.25Z");
    const endsAt = Temporal.Instant.from("2030-01-10T04:00:00Z");

    await inRollback(db, async (db) => {
      await db.execute(sql.raw(`set local time zone '${zone}'`));
      const [row] = await db
        .insert(notes)
        .values({ ...note, startsAt, endsAt })
        .returning();

      expect(row?.firstNight.equals(note.firstNight)).toBe(true);
      expect(row?.startsAt?.equals(startsAt)).toBe(true);
      expect(row?.endsAt?.equals(endsAt)).toBe(true);
      expect(row?.createdAt).toBeInstanceOf(Temporal.Instant);
    });
  },
);

describe("constraints", () => {
  const rejects = [
    ["an unknown category", "notes_category", { category: "dream" }],
    ["an unknown channel", "notes_author_channel", { authorChannel: "email" }],
    ["an unknown precision", "notes_date_precision", { datePrecision: "week" }],
    [
      "a month that isn't stored as its 1st",
      "notes_dates_match_precision",
      { datePrecision: "month", firstNight: Temporal.PlainDate.from("2030-01-10") },
    ],
    [
      "a year whose last night isn't 1 January",
      "notes_dates_match_precision",
      {
        datePrecision: "year",
        firstNight: Temporal.PlainDate.from("2030-01-01"),
        lastNight: Temporal.PlainDate.from("2031-03-01"),
      },
    ],
    [
      "a last night before the first",
      "notes_last_night_order",
      { lastNight: Temporal.PlainDate.from("2030-01-09") },
    ],
    [
      "a time range with one end",
      "notes_time_range",
      { startsAt: Temporal.Instant.from("2030-01-10T03:00Z") },
    ],
    [
      "a time range out of order",
      "notes_time_range",
      {
        startsAt: Temporal.Instant.from("2030-01-10T04:00Z"),
        endsAt: Temporal.Instant.from("2030-01-10T03:00Z"),
      },
    ],
    [
      "a time range on a note known only to the month",
      "notes_time_range",
      {
        datePrecision: "month",
        firstNight: Temporal.PlainDate.from("2030-01-01"),
        startsAt: Temporal.Instant.from("2030-01-10T03:00Z"),
        endsAt: Temporal.Instant.from("2030-01-10T04:00Z"),
      },
    ],
    ["a 32,001-character body", "notes_body_length", { body: "x".repeat(32_001) }],
    ["a body of only spaces", "notes_body_length", { body: "  \n " }],
    [
      "an edit without its editor",
      "notes_updated_together",
      { updatedAt: Temporal.Instant.from("2030-01-11T00:00Z") },
    ],
  ] as const;

  migrated.for(rejects)("a note with %s fails", async ([, constraint, change], { db }) => {
    await inRollback(db, async (db) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CHECK constraints reject values the column types already forbid, so the test has to cast
      const values = { ...note, ...change } as typeof notes.$inferInsert;

      expect(await brokenConstraint(db.insert(notes).values(values))).toBe(constraint);
    });
  });

  migrated("a note dated to the month or year passes", async ({ db }) => {
    await inRollback(db, async (db) => {
      await db.insert(notes).values([
        { ...note, datePrecision: "month", firstNight: Temporal.PlainDate.from("2030-02-01") },
        {
          ...note,
          datePrecision: "year",
          firstNight: Temporal.PlainDate.from("2030-01-01"),
          lastNight: Temporal.PlainDate.from("2031-01-01"),
        },
      ]);
    });
  });

  migrated.for([
    ["a spec link with SQL", { ...link, kind: "spec" }],
    ["a SQL link with no SQL", { ...link, sql: null }],
    [
      "a SQL link that also holds a spec",
      { ...link, spec: { v: 1, dataset: "nights", nights: { last: 7 } } },
    ],
  ] as const)("%s fails", async ([, row], { db }) => {
    await inRollback(db, async (db) => {
      expect(await brokenConstraint(db.insert(shortLinks).values(row))).toBe(
        "short_links_content_matches_kind",
      );
    });
  });

  migrated("a finding can point only at a finding note", async ({ db }) => {
    await inRollback(db, async (db) => {
      await db.insert(shortLinks).values(link);
      const other = await addNote(db, note);
      const finding = await addNote(db, { ...note, category: "finding" });

      await db.insert(findings).values({ noteId: finding, shortCode: link.code });
      await db.insert(findingSnapshots).values({
        noteId: finding,
        derivedVersion: 1,
        ranAt: Temporal.Now.instant(),
        result: { columns: ["n"], rows: [[1]], truncated: false },
      });

      expect(
        await brokenConstraint(db.insert(findings).values({ noteId: other, shortCode: link.code })),
      ).toBe("findings_note");
    });
  });

  migrated("a note in use by a finding can't change category", async ({ db }) => {
    await inRollback(db, async (db) => {
      await db.insert(shortLinks).values(link);
      const finding = await addNote(db, { ...note, category: "finding" });

      await db.insert(findings).values({ noteId: finding, shortCode: link.code });

      expect(
        await brokenConstraint(
          db.update(notes).set({ category: "other" }).where(eq(notes.id, finding)),
        ),
      ).toBe("findings_note");
    });
  });

  migrated("history rejects a negative row count", async ({ db }) => {
    await inRollback(db, async (db) => {
      await db.insert(shortLinks).values(link);
      const write = db
        .insert(queryHistory)
        .values({ shortCode: link.code, ...author, rowCount: -1, truncated: false });

      expect(await brokenConstraint(write)).toBe("query_history_row_count");
    });
  });
});
