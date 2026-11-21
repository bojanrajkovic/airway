import { describe, expect, it } from "vitest";
import { ahiCheck, nightRow, type NightEvent } from "../../src/derived/nights.ts";
import type { Session } from "../../src/derived/sessions.ts";
import type { UsedStrDay } from "../../src/derived/str.ts";

const night = Temporal.PlainDate.from("2030-01-07");
const at = (minutes: number): Temporal.Instant =>
  Temporal.Instant.from("2030-01-08T02:00:00Z").add({ minutes });

function day(signals: Record<string, number | null>, maskEvents = 2): UsedStrDay {
  return { day: night, used: true, maskOn: [], maskOff: [], maskEvents, signals, settings: {} };
}

const events = (count: number, event: Partial<NightEvent> = {}): NightEvent[] =>
  Array.from({ length: count }, () => ({
    type: "hypopnea",
    outside_mask_on: false,
    ...event,
  }));

describe("ahiCheck", () => {
  it("matches 18 events in 400 minutes to an AHI of 2.7, which floating point puts at 2.69999…", () => {
    expect(ahiCheck(day({ usage: 400, ahi: 2.7 }), events(18))).toEqual({
      outcome: "match",
      tenths: 27,
    });
  });

  it("reports both AHIs in tenths when they disagree", () => {
    expect(ahiCheck(day({ usage: 400, ahi: 2.8 }), events(18))).toEqual({
      outcome: "mismatch",
      computed: 27,
      machine: 28,
    });
  });

  it("counts a machine AHI the day lacks as a mismatch", () => {
    expect(ahiCheck(day({ usage: 400, ahi: null }), events(18))).toEqual({
      outcome: "mismatch",
      computed: 27,
      machine: null,
    });
  });

  it("gives no_usage when the mask was never on", () => {
    expect(ahiCheck(day({ usage: 0, ahi: 0 }), [])).toEqual({ outcome: "no_usage" });
    expect(ahiCheck(day({ usage: null, ahi: null }), [])).toEqual({ outcome: "no_usage" });
  });

  it("counts apneas and hypopneas outside mask-on time, but not arousals or other events", () => {
    const counted = [
      ...events(1, { type: "obstructive_apnea" }),
      ...events(1, { type: "central_apnea" }),
      ...events(1, { type: "unclassified_apnea", outside_mask_on: true }),
      ...events(1, { type: "hypopnea", outside_mask_on: true }),
    ];
    const ignored = [...events(5, { type: "arousal" }), ...events(5, { type: "other" })];

    // 4 events in 60 minutes is an AHI of 4.0.
    expect(ahiCheck(day({ usage: 60, ahi: 4 }), [...counted, ...ignored])).toEqual({
      outcome: "match",
      tenths: 40,
    });
  });
});

describe("nightRow", () => {
  const sessions: Session[] = [
    { session: 1, start: at(0), end: at(90), source: "str" },
    { session: 2, start: at(100), end: at(250), source: "derived" },
  ];
  const nightEvents = [
    ...events(2, { type: "obstructive_apnea" }),
    ...events(1, { type: "central_apnea", outside_mask_on: true }),
    ...events(3, { type: "unclassified_apnea" }),
    ...events(4, { type: "hypopnea" }),
    ...events(5, { type: "arousal", outside_mask_on: true }),
    ...events(1, { type: "other" }),
  ];
  const { row, ahi } = nightRow({
    day: day({ usage: 240, ahi: 2.5, leak_p95: 0.2 }, 6),
    sessions: { sessions, approximate: true },
    events: nightEvents,
    ruleSet: "pediatric",
  });

  it("fills the night's columns from its day, sessions, events, and rule set", () => {
    expect(row).toEqual({
      night,
      signals: { usage: 240, ahi: 2.5, leak_p95: 0.2 },
      sessions: 2,
      expected_sessions: 3,
      session_count_approximate: true,
      longest_stretch: 150,
      obstructive_apneas: 2,
      central_apneas: 1,
      unclassified_apneas: 3,
      hypopneas: 4,
      arousals: 5,
      events_outside_mask_on: 6,
      ahi_check: "match",
      rule_set: "pediatric",
    });
  });

  it("returns the AHI check whose outcome fills ahi_check", () => {
    // 10 apneas and hypopneas in 240 minutes is an AHI of 2.5.
    expect(ahi).toEqual({ outcome: "match", tenths: 25 });
  });

  it("gives a night with no sessions a longest stretch of 0", () => {
    const empty = nightRow({
      day: day({ usage: 0, ahi: 0 }, 0),
      sessions: { sessions: [], approximate: false },
      events: [],
      ruleSet: "adult",
    });

    expect(empty.row.longest_stretch).toBe(0);
  });
});
