import { describe, expect, it } from "vitest";
import { RuleSet } from "../../src/profile.ts";
import {
  ahiCheck,
  nightRow,
  possiblyCorrupted,
  type NightEvent,
} from "../../src/derived/nights.ts";
import type { Session } from "../../src/derived/sessions.ts";
import type { UsedStrDay } from "../../src/derived/str.ts";
import { EventType, FileChecksum, SessionSource } from "../../src/derived/values.ts";

const night = Temporal.PlainDate.from("2030-01-07");
const at = (minutes: number): Temporal.Instant =>
  Temporal.Instant.from("2030-01-08T02:00:00Z").add({ minutes });

function day(signals: Record<string, number | null>, maskEvents = 2): UsedStrDay {
  return { day: night, used: true, maskOn: [], maskOff: [], maskEvents, signals, settings: {} };
}

const events = (count: number, event: Partial<NightEvent> = {}): NightEvent[] =>
  Array.from({ length: count }, () => ({
    type: EventType.Hypopnea,
    outside_mask_on: false,
    ...event,
  }));

describe("ahiCheck", () => {
  it("matches 18 events in 400 minutes to an AHI of 2.7, though 18 / 400 × 60 comes to 2.69999… in floating point", () => {
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

  it("returns mismatch when the day has no machine AHI", () => {
    expect(ahiCheck(day({ usage: 400, ahi: null }), events(18))).toEqual({
      outcome: "mismatch",
      computed: 27,
      machine: null,
    });
  });

  it("returns no_usage when usage is 0 or missing", () => {
    expect(ahiCheck(day({ usage: 0, ahi: 0 }), [])).toEqual({ outcome: "no_usage" });
    expect(ahiCheck(day({ usage: null, ahi: null }), [])).toEqual({ outcome: "no_usage" });
  });

  it("counts apneas and hypopneas, including those outside mask-on time, and skips arousals and other events", () => {
    const counted = [
      ...events(1, { type: EventType.ObstructiveApnea }),
      ...events(1, { type: EventType.CentralApnea }),
      ...events(1, { type: EventType.UnclassifiedApnea, outside_mask_on: true }),
      ...events(1, { type: EventType.Hypopnea, outside_mask_on: true }),
    ];
    const ignored = [
      ...events(5, { type: EventType.Arousal }),
      ...events(5, { type: EventType.Other }),
    ];

    // 4 events in 60 minutes is an AHI of 4.0.
    expect(ahiCheck(day({ usage: 60, ahi: 4 }), [...counted, ...ignored])).toEqual({
      outcome: "match",
      tenths: 40,
    });
  });
});

describe("nightRow", () => {
  const sessions: Session[] = [
    { session: 1, start: at(0), end: at(90), source: SessionSource.Str },
    { session: 2, start: at(100), end: at(250), source: SessionSource.Derived },
  ];
  const nightEvents = [
    ...events(2, { type: EventType.ObstructiveApnea }),
    ...events(1, { type: EventType.CentralApnea, outside_mask_on: true }),
    ...events(3, { type: EventType.UnclassifiedApnea }),
    ...events(4, { type: EventType.Hypopnea }),
    ...events(5, { type: EventType.Arousal, outside_mask_on: true }),
    ...events(1, { type: EventType.Other }),
  ];
  const { row, ahi } = nightRow({
    day: day({ usage: 240, ahi: 2.5, leak_p95: 0.2 }, 6),
    sessions: { sessions, approximate: true },
    events: nightEvents,
    ruleSet: RuleSet.Pediatric,
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

  it("returns the AHI check and writes its outcome to ahi_check", () => {
    // 10 apneas and hypopneas in 240 minutes is an AHI of 2.5.
    expect(ahi).toEqual({ outcome: "match", tenths: 25 });
  });

  it("sets longest_stretch to 0 for a night with no sessions", () => {
    const empty = nightRow({
      day: day({ usage: 0, ahi: 0 }, 0),
      sessions: { sessions: [], approximate: false },
      events: [],
      ruleSet: RuleSet.Adult,
    });

    expect(empty.row.longest_stretch).toBe(0);
  });
});

describe("possiblyCorrupted", () => {
  const clean = { checksum: FileChecksum.Match, bad_records: 0 };
  const unread = { checksum: FileChecksum.Unchecked, bad_records: null };

  it("returns false when every file matches or is unchecked and the rejected count is 0", () => {
    expect(possiblyCorrupted([clean, unread], 0)).toBe(false);
  });

  it.each([
    ["a file that doesn't match its .crc", { checksum: FileChecksum.Mismatch, bad_records: 0 }],
    ["a file with a bad record", { checksum: FileChecksum.Unchecked, bad_records: 1 }],
  ])("returns true for %s", (_, file) => {
    expect(possiblyCorrupted([clean, file], 0)).toBe(true);
  });

  it("returns true when checkFileSize rejected one of the night's files", () => {
    expect(possiblyCorrupted([clean], 1)).toBe(true);
  });
});
