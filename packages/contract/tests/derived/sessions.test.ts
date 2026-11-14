import { describe, expect, it } from "vitest";
import { ClockOffset } from "../../src/clock.ts";
import {
  assignEvents,
  buildSessions,
  type SessionInputs,
  type Span,
} from "../../src/derived/sessions.ts";

const night = Temporal.PlainDate.from("2030-01-07");
const offset = ClockOffset.parse({ from: "2030-01-01", utcOffset: "-05:00" });
// Noon on the device clock, -05:00, is 17:00 UTC.
const at = (minutesSinceNoon: number, seconds = 0): Temporal.Instant =>
  Temporal.Instant.from("2030-01-07T17:00:00Z").add({ seconds: minutesSinceNoon * 60 + seconds });
const span = (start: Temporal.Instant, end: Temporal.Instant): Span => ({ start, end });

function inputs(overrides: Partial<SessionInputs>): SessionInputs {
  return {
    night,
    offset,
    maskOn: [],
    maskOff: [],
    maskEvents: 0,
    segments: [],
    ...overrides,
  };
}

describe("buildSessions", () => {
  it("makes a session per STR slot and puts each segment in the one it overlaps", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540, 700],
        maskOff: [640, 760],
        maskEvents: 4,
        // The first period's two files are 100 s apart; the slot's minute floors its start 40 s early.
        segments: [span(at(540, 40), at(590)), span(at(591, 40), at(640)), span(at(700), at(760))],
      }),
    );

    expect(built.sessions).toEqual([
      { session: 1, start: at(540), end: at(640), source: "str" },
      { session: 2, start: at(700), end: at(760), source: "str" },
    ]);
    expect(built.segmentSessions).toEqual([1, 1, 2]);
    expect(built.approximate).toBe(false);
  });

  it("starts slot 0 at noon when it has a mask-off but no mask-on", () => {
    const built = buildSessions(inputs({ maskOn: [Number.NaN], maskOff: [30], maskEvents: 2 }));

    expect(built.sessions).toEqual([{ session: 1, start: at(0), end: at(30), source: "str" }]);
  });

  it("matches a segment within 60 s of a session, and no further", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540],
        maskOff: [600],
        maskEvents: 2,
        segments: [span(at(600, 50), at(620)), span(at(602), at(630))],
      }),
    );

    expect(built.segmentSessions).toEqual([1, 2]);
    expect(built.sessions[1]?.source).toBe("derived");
  });

  it("gives a segment that overlaps two sessions to the larger overlap", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540, 601],
        maskOff: [600, 700],
        maskEvents: 4,
        segments: [span(at(590), at(650))],
      }),
    );

    expect(built.segmentSessions).toEqual([2]);
  });

  it("joins leftover segments 90 s or less apart into derived sessions after the 10 slots", () => {
    const slots = Array.from({ length: 10 }, (_, i) => 60 * i);
    const built = buildSessions(
      inputs({
        maskOn: slots,
        maskOff: slots.map((minute) => minute + 30),
        maskEvents: 2 * 12,
        segments: [
          span(at(600), at(620)),
          // 90 s after the last: joins.
          span(at(621, 30), at(640)),
          // 91 s after the last: a new session.
          span(at(641, 31), at(660)),
        ],
      }),
    );

    expect(built.sessions.slice(10)).toEqual([
      { session: 11, start: at(600), end: at(640), source: "derived" },
      { session: 12, start: at(641, 31), end: at(660), source: "derived" },
    ]);
    expect(built.segmentSessions).toEqual([11, 11, 12]);
    expect(built.approximate).toBe(false);
  });

  it("flags the night when the sessions can't add up to the machine's count", () => {
    const built = buildSessions(inputs({ maskOn: [540], maskOff: [600], maskEvents: 6 }));

    expect(built.approximate).toBe(true);
  });
});

describe("assignEvents", () => {
  const sessions = [
    { session: 1, start: at(540), end: at(600), source: "str" as const },
    { session: 2, start: at(700), end: at(760), source: "str" as const },
  ];

  it("puts an event in the session that holds it, allowing 60 s past either end", () => {
    expect(assignEvents([span(at(550), at(551)), span(at(600, 30), at(601))], sessions)).toEqual([
      { session: 1, outsideMaskOn: false },
      { session: 1, outsideMaskOn: false },
    ]);
  });

  it("gives an event outside every session to the nearest one, marked outside mask-on", () => {
    expect(assignEvents([span(at(610), at(611)), span(at(690), at(691))], sessions)).toEqual([
      { session: 1, outsideMaskOn: true },
      { session: 2, outsideMaskOn: true },
    ]);
  });

  it("leaves the session empty on a night with no sessions", () => {
    expect(assignEvents([span(at(550), at(551))], [])).toEqual([
      { session: null, outsideMaskOn: true },
    ]);
  });
});
