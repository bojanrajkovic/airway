import { expect } from "vitest";
import { z } from "zod";
import { derivedIndexesAndKeys, derivedTables } from "@airway/contract/derived/ddl";
import { FileChecksum } from "@airway/contract/derived/values";
import { EdgeCaseName } from "@airway/synthetic/cases";
import { test, withClient } from "@airway/testing/postgres";
import { parseIdentification } from "../../src/ingest/identification.ts";
import { readStr } from "../../src/ingest/str.ts";
import { checkStrHistory, writeStr, type StrInput } from "../../src/ingest/write-str.ts";
import { fileStates, synthesizedNights } from "../support/cpap-folder.ts";
import { testContext } from "../support/context.ts";

const { files, rows } = synthesizedNights([
  EdgeCaseName.FolderlessDay,
  EdgeCaseName.UnusedDays,
  EdgeCaseName.SettingsChange,
]);
const bytesOf = (path: string): Uint8Array =>
  files.find((file) => file.path === path)?.bytes ?? new Uint8Array();
const input: StrInput = {
  str: readStr(bytesOf("STR.edf"))._unsafeUnwrap(),
  identification: {
    device: parseIdentification(bytesOf("Identification.tgt"))._unsafeUnwrap(),
    check: FileChecksum.Match,
  },
  files: fileStates(files).ready.filter(({ night }) => night === null),
};
const ctx = testContext();

// The tests in this file share one database, so each test drops and recreates the `derived` schema.
const FRESH = `drop schema if exists derived cascade; ${derivedTables("derived")} ${derivedIndexesAndKeys("derived")}`;

test("writes the STR.edf tables, the device row, and the root files' `files` rows that synthesize expects", async ({
  databaseUrl,
}) => {
  const written = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    // A second write must replace the first one's rows.
    (await writeStr(ctx, client, "derived", input))._unsafeUnwrap();
    (await writeStr(ctx, client, "derived", input))._unsafeUnwrap();

    const query = async <T extends z.ZodType>(schema: T, sql: string): Promise<z.infer<T>[]> =>
      z.array(schema).parse((await client.query(sql)).rows);

    return {
      usage: await query(
        z.object({ day: z.string(), usage: z.number() }),
        "select day::text as day, usage from derived.daily_usage order by day",
      ),
      changes: await query(
        z.object({
          night: z.string(),
          setting: z.string(),
          old_value: z.number().nullable(),
          new_value: z.number().nullable(),
        }),
        "select night::text as night, setting, old_value, new_value from derived.settings_changes order by night, setting",
      ),
      device: await query(
        z.object({ serial: z.string(), model: z.string() }),
        "select serial, model from derived.device",
      ),
      files: await query(
        z.object({
          path: z.string(),
          kind: z.string(),
          size: z.number(),
          sha256: z.string(),
          checksum: z.string(),
          bad_records: z.number().nullable(),
        }),
        "select path, kind, size::int as size, sha256, checksum, bad_records from derived.files order by path",
      ),
    };
  });
  const fileRows = rows.files.filter(({ night }) => night === null);

  expect(written.usage).toEqual(
    rows.daily_usage.map(({ day, usage }) => ({ day: day.toString(), usage })),
  );
  expect(written.usage.some(({ usage }) => usage === 0)).toBe(true);
  expect(written.changes).toEqual(
    rows.settings_changes.map((change) => ({ ...change, night: change.night.toString() })),
  );
  expect(written.changes).not.toEqual([]);
  expect(written.device).toEqual(rows.device);
  expect(written.files).toEqual(
    fileRows
      .map(({ path, kind, size, sha256, checksum, bad_records }) => ({
        path,
        kind,
        size,
        sha256,
        checksum,
        bad_records,
      }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  );
});

test("counts the nights older than STR.edf's first used day", async ({ databaseUrl }) => {
  const [before, after] = await withClient(databaseUrl, async (client) => {
    await client.query(FRESH);
    const counted = async (): Promise<number> =>
      (await checkStrHistory(ctx, client, "derived", input.str))._unsafeUnwrap();
    const none = await counted();
    const first = input.str.days.find(({ used }) => used)?.day.subtract({ days: 30 });

    await client.query(
      `insert into derived.nights (night, sessions, expected_sessions, session_count_approximate,
         longest_stretch, obstructive_apneas, central_apneas, unclassified_apneas, hypopneas,
         arousals, events_outside_mask_on, ahi_check, rule_set, possibly_corrupted, arrived_at)
       values ($1, 1, 1, false, 480, 0, 0, 0, 0, 0, 0, 'match', 'pediatric', false, now())`,
      [first?.toString()],
    );

    return [none, await counted()];
  });

  expect([before, after]).toEqual([0, 1]);
});
