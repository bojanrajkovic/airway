import { createHash } from "node:crypto";
import { test as base, describe, expect } from "vitest";
import { EventType, FileChecksum, FileKind, SessionSource } from "@airway/contract/derived/values";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";
import { Patient } from "../src/patients.ts";
import { synthesize, type Synthesized } from "../src/synthesize.ts";

const zone = "America/New_York";
const arrivedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");
const { nights } = syntheticNights({ seed: 7, nights: 4 })._unsafeUnwrap();

const run = (list: readonly SyntheticNight[]): Synthesized =>
  synthesize(list, zone, { patient: Patient.Child, arrivedAt })._unsafeUnwrap();
// Builds a fresh folder and rows from `nights` for each test that uses `synthesized`.
const test = base.extend<{ synthesized: Synthesized }>({
  synthesized: async ({}, use) => {
    await use(run(nights));
  },
});
const ofNight = <T extends { night: Temporal.PlainDate | null }>(
  rows: readonly T[],
  night: SyntheticNight,
): T[] => rows.filter((row) => row.night?.equals(night.night) === true);

describe("synthesize", () => {
  test("writes one row per night, with the machine's AHI and an `ahi_check` of `match`", ({
    synthesized: { rows },
  }) => {
    expect(rows.nights.map((row) => row.night.toString())).toEqual(
      nights.map((night) => night.night.toString()),
    );

    for (const [i, row] of rows.nights.entries()) {
      expect(row.signals["ahi"]).toBe(nights[i]?.str["AHI"]);
      expect(row.ahi_check).toBe("match");
      expect(row.rule_set).toBe("pediatric");
    }
  });

  test("writes one sample per 2 s of each segment, starting when the segment's PLD file starts", ({
    synthesized: { rows },
  }) => {
    for (const night of nights) {
      const seconds = night.segments.reduce(
        (sum, { start, end }) => sum + start.until(end).total("seconds"),
        0,
      );
      const samples = ofNight(rows.samples, night);

      expect(samples).toHaveLength(seconds / 2);
      expect(samples[0]?.ts.equals(night.segments[0]?.start.add({ seconds: 1 }) ?? arrivedAt)).toBe(
        true,
      );
    }
  });

  test("puts every segment, event, sample, and breath in a session", ({
    synthesized: { rows },
  }) => {
    const sessions = new Set(
      rows.sessions.map((row) => `${row.night.toString()}/${row.session.toString()}`),
    );

    const orphans = [...rows.segments, ...rows.events, ...rows.samples, ...rows.breaths].filter(
      (row) => !sessions.has(`${row.night.toString()}/${String(row.session)}`),
    );

    expect(orphans).toEqual([]);
  });

  test("starts each apnea row at the modeled start and each hypopnea or arousal row at the modeled end, rounded to the whole second", ({
    synthesized: { rows },
  }) => {
    const [night] = nights;
    const events = night === undefined ? [] : ofNight(rows.events, night);

    expect(events).toHaveLength(night?.events.length ?? -1);
    events.forEach((row, i) => {
      const event = night?.events[i];
      const at = event?.at ?? row.ts;
      // The machine writes a hypopnea or arousal at the time the event ends, with a 0 duration.
      const start = row.duration === null ? at.add({ seconds: event?.duration ?? 0 }) : at;

      expect(Math.abs(start.until(row.ts).total("seconds"))).toBeLessThanOrEqual(0.5);
    });
  });

  test("writes a null duration for hypopneas and arousals, and a duration of at least 10 s for apneas", ({
    synthesized: { rows },
  }) => {
    const untimed = rows.events.filter(
      ({ type }) => type === EventType.Hypopnea || type === EventType.Arousal,
    );
    const timed = rows.events.filter(({ type }) => type.endsWith("_apnea"));

    expect(untimed).not.toHaveLength(0);
    expect(untimed.every(({ duration }) => duration === null)).toBe(true);
    expect(timed).not.toHaveLength(0);
    expect(timed.every(({ duration }) => duration !== null && duration >= 10)).toBe(true);
  });

  test("lists the files that ingest imports, with each file's size and SHA-256", ({
    synthesized: { files, rows },
  }) => {
    const byPath = new Map(files.map((file) => [file.path, file.bytes]));
    const kinds = new Set(rows.files.map((row) => row.kind));

    expect(kinds).toEqual(new Set(["identification", "str", "brp", "pld", "eve", "crc"]));

    for (const row of rows.files) {
      const bytes = byPath.get(row.path);

      expect(bytes?.length).toBe(row.size);
      expect(row.sha256).toBe(
        createHash("sha256")
          .update(bytes ?? new Uint8Array())
          .digest("hex"),
      );
      expect(row.ctime).toBe(arrivedAt);
    }

    // Each segment has exactly one BRP file naming it.
    for (const segment of rows.segments) {
      const brps = rows.files.filter(
        (file) =>
          file.kind === FileKind.Brp &&
          file.night?.equals(segment.night) === true &&
          file.segment === segment.segment,
      );

      expect(brps).toHaveLength(1);
    }
  });

  test("sets possibly_corrupted to false on every night and marks every BRP, PLD, and EVE file as matching its .crc", ({
    synthesized: { rows },
  }) => {
    const nightFiles = rows.files.filter(({ kind }) =>
      [FileKind.Brp, FileKind.Pld, FileKind.Eve].includes(kind),
    );

    expect(rows.nights.every(({ possibly_corrupted }) => !possibly_corrupted)).toBe(true);
    expect(nightFiles.length).toBeGreaterThan(0);

    for (const file of nightFiles) {
      expect(file).toMatchObject({ checksum: FileChecksum.Match, bad_records: 0 });
    }
  });

  test("writes only a daily usage row for a night with no segments", () => {
    const [first, second, ...rest] = nights;

    if (first === undefined || second === undefined) {
      throw new Error("expected four nights");
    }

    const edited = run([first, { ...second, segments: [], eventFiles: [] }, ...rest]).rows;

    expect(edited.daily_usage.find((row) => row.day.equals(second.night))?.usage).toBe(
      second.str["OnDuration"],
    );

    const nightRows: readonly { night: Temporal.PlainDate | null }[] = [
      ...edited.nights,
      ...edited.files,
      ...edited.sessions,
      ...edited.segments,
      ...edited.events,
      ...edited.samples,
      ...edited.breaths,
    ];

    expect(ofNight(nightRows, second)).toEqual([]);
  });

  test("writes zero usage for a day with no night", () => {
    const [first, , third] = nights;
    const gap = run([first, third].filter((night) => night !== undefined)).rows;

    expect(gap.daily_usage.map((row) => row.usage)).toEqual([
      first?.str["OnDuration"],
      0,
      third?.str["OnDuration"],
    ]);
  });

  test("records a setting that changes from one night to the next", () => {
    const [first, second] = nights;

    if (first === undefined || second === undefined) {
      throw new Error("expected four nights");
    }

    const raised = { ...second, str: { ...second.str, "S.AS.MaxPress": 14 } };

    expect(run([first, raised]).rows.settings_changes).toEqual([
      {
        night: second.night,
        setting: "max_pressure",
        old_value: first.str["S.AS.MaxPress"],
        new_value: 14,
      },
    ]);
  });

  test("puts a setting change on the night it happened, even when that night has no folder", () => {
    const [first, second, third] = nights;

    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected four nights");
    }

    const raise = (night: SyntheticNight): SyntheticNight => ({
      ...night,
      str: { ...night.str, "S.AS.MaxPress": 14 },
    });
    const folderless = { ...raise(second), segments: [], eventFiles: [], events: [] };
    const { rows } = run([first, folderless, raise(third)]);

    expect(rows.nights.map((row) => row.night)).toEqual([first.night, third.night]);
    expect(rows.settings_changes).toEqual([
      {
        night: second.night,
        setting: "max_pressure",
        old_value: first.str["S.AS.MaxPress"],
        new_value: 14,
      },
    ]);
  });

  test("uses the BRP files to rebuild the sessions beyond the 10 that fit in STR.edf", () => {
    // Seed 1's second night has 15 periods.
    const busy = syntheticNights({ seed: 1, nights: 2 })
      ._unsafeUnwrap()
      .nights.find((night) => night.periods.length > 10);

    if (busy === undefined) {
      throw new Error("expected a night with more than 10 periods");
    }

    const {
      sessions,
      nights: [row],
    } = run([busy]).rows;

    expect(sessions.filter((session) => session.source === SessionSource.Str)).toHaveLength(10);
    expect(sessions.some((session) => session.source === SessionSource.Derived)).toBe(true);
    expect(row?.expected_sessions).toBe(busy.periods.length);
    expect(row?.session_count_approximate).toBe(sessions.length !== busy.periods.length);
  });
});
