import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClockOffsets } from "@airway/contract/clock";
import { syntheticNights, type SyntheticNight } from "../src/model.ts";
import { synthesize, type Synthesized } from "../src/synthesize.ts";

const offsets = ClockOffsets.parse([{ from: "2030-01-01", utcOffset: "-05:00" }]);
const uploadedAt = Temporal.Instant.from("2030-03-01T12:00:00Z");
const nights = syntheticNights({ seed: 7, nights: 4 });

const run = (list: readonly SyntheticNight[]): Synthesized =>
  synthesize(list, offsets, { patient: "child", uploadedAt })._unsafeUnwrap();
const ofNight = <T extends { night: Temporal.PlainDate | null }>(
  rows: readonly T[],
  night: SyntheticNight,
): T[] => rows.filter((row) => row.night?.equals(night.night) === true);

describe("synthesize", () => {
  const { files, rows } = run(nights);

  it("gives every night a row with the machine's AHI, matched by airway's count", () => {
    expect(rows.nights.map((row) => row.night.toString())).toEqual(
      nights.map((night) => night.night.toString()),
    );

    for (const [i, row] of rows.nights.entries()) {
      expect(row.signals["ahi"]).toBe(nights[i]?.str.get("AHI"));
      expect(row.ahi_check).toBe("match");
      expect(row.rule_set).toBe("pediatric");
    }
  });

  it("writes one sample per 2 s of each segment, starting with its PLD file", () => {
    for (const night of nights) {
      const seconds = night.segments.reduce(
        (sum, { start, end }) => sum + start.until(end).total("seconds"),
        0,
      );
      const samples = ofNight(rows.samples, night);

      expect(samples).toHaveLength(seconds / 2);
      expect(
        samples[0]?.ts.equals(night.segments[0]?.start.add({ seconds: 1 }) ?? uploadedAt),
      ).toBe(true);
    }
  });

  it("puts every segment, event, sample, and breath in a session", () => {
    const sessions = new Set(
      rows.sessions.map((row) => `${row.night.toString()}/${row.session.toString()}`),
    );

    for (const row of [...rows.segments, ...rows.events, ...rows.samples, ...rows.breaths]) {
      expect(sessions).toContain(`${row.night.toString()}/${String(row.session)}`);
    }
  });

  it("starts each event where the model put it, to the second EVE keeps", () => {
    const [night] = nights;
    const events = night === undefined ? [] : ofNight(rows.events, night);

    expect(events).toHaveLength(night?.events.length ?? -1);
    events.forEach((row, i) => {
      const at = night?.events[i]?.at ?? row.ts;

      expect(Math.abs(at.until(row.ts).total("seconds"))).toBeLessThanOrEqual(0.5);
    });
  });

  it("lists the files ingest imports, with their sizes and SHA-256", () => {
    const byPath = new Map(files.map((file) => [file.path, file.bytes]));
    const kinds = new Set(rows.files.map((row) => row.kind));

    expect(kinds).toEqual(new Set(["identification", "str", "brp", "pld", "eve"]));

    for (const row of rows.files) {
      const bytes = byPath.get(row.path);

      expect(bytes?.length).toBe(row.size);
      expect(row.sha256).toBe(
        createHash("sha256")
          .update(bytes ?? new Uint8Array())
          .digest("hex"),
      );
      expect(row.ctime).toBe(uploadedAt);
    }

    expect(rows.segments.every((row) => byPath.has(row.brp_path))).toBe(true);
  });

  it("gives a night with no segments only its daily usage", () => {
    const [first, second, ...rest] = nights;

    if (first === undefined || second === undefined) {
      throw new Error("expected four nights");
    }

    const edited = run([first, { ...second, segments: [] }, ...rest]).rows;

    expect(edited.daily_usage.find((row) => row.day.equals(second.night))?.usage).toBe(
      second.str.get("OnDuration"),
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

  it("gives a day with no night zero usage", () => {
    const [first, , third] = nights;
    const gap = run([first, third].filter((night) => night !== undefined)).rows;

    expect(gap.daily_usage.map((row) => row.usage)).toEqual([
      first?.str.get("OnDuration"),
      0,
      third?.str.get("OnDuration"),
    ]);
  });

  it("records a setting that changes from one night to the next", () => {
    const [first, second] = nights;

    if (first === undefined || second === undefined) {
      throw new Error("expected four nights");
    }

    const raised = { ...second, str: new Map(second.str).set("S.AS.MaxPress", 14) };

    expect(run([first, raised]).rows.settings_changes).toEqual([
      {
        night: second.night,
        setting: "max_pressure",
        old_value: first.str.get("S.AS.MaxPress"),
        new_value: 14,
      },
    ]);
  });

  it("rebuilds sessions past STR.edf's 10 slots from the BRP files", () => {
    const busy = syntheticNights({ seed: 3, nights: 60 }).find(
      (night) => night.periods.length > 10,
    );

    if (busy === undefined) {
      throw new Error("expected a night with more than 10 periods");
    }

    const {
      sessions,
      nights: [row],
    } = run([busy]).rows;

    expect(sessions.filter((session) => session.source === "str")).toHaveLength(10);
    expect(sessions.some((session) => session.source === "derived")).toBe(true);
    expect(row?.expected_sessions).toBe(busy.periods.length);
    expect(row?.session_count_approximate).toBe(sessions.length !== busy.periods.length);
  });
});
