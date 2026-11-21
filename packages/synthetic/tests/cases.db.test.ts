import pg from "pg";
import { expect } from "vitest";
import { z } from "zod";
import { test } from "@airway/testing/postgres";
import { loadDerived } from "../src/load.ts";
import { syntheticNights } from "../src/model.ts";
import { synthesize } from "../src/synthesize.ts";

const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");
const Count = z.array(z.object({ count: z.coerce.number() }));

test(
  "loads every edge case that 'all' builds, one night row per night with a folder",
  // Building and loading every case takes a few seconds, near Vitest's 5 s default.
  { timeout: 30_000 },
  async ({ databaseUrl }) => {
    const model = syntheticNights({ seed: 7, nights: 0, cases: "all" })._unsafeUnwrap();
    const { rows } = synthesize(model.nights, model.zone, {
      patient: "child",
      arrivedAt,
    })._unsafeUnwrap();
    const client = new pg.Client(databaseUrl);
    await client.connect();

    try {
      await loadDerived(client, rows, { schema: "derived", builtAt: arrivedAt });

      const loaded = Count.parse((await client.query("select count(*) from derived.nights")).rows);

      expect(loaded).toEqual([{ count: rows.nights.length }]);
    } finally {
      await client.end();
    }
  },
);
