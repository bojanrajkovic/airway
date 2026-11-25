import { describe, expect, it } from "vitest";
import {
  assignEvents,
  buildSessions,
  type SessionInputs,
  type Span,
} from "../../src/derived/sessions.ts";

const night = Temporal.PlainDate.from("2030-01-07");
const zone = "America/New_York";
// Noon on the device clock, -05:00, is 17:00 UTC.
const at = (minutesSinceNoon: number, seconds = 0): Temporal.Instant =>
  Temporal.Instant.from("2030-01-07T17:00:00Z").add({ seconds: minutesSinceNoon * 60 + seconds });
const span = (start: Temporal.Instant, end: Temporal.Instant): Span => ({ start, end });

function inputs(overrides: Partial<SessionInputs>): SessionInputs {
  return {
    night,
    zone,
    maskOn: [],
    maskOff: [],
    maskEvents: 0,
    segments: [],
    ...overrides,
  };
}

describe("buildSessions", () => {
  it("ignores a slot whose mask-on and mask-off fall in the same minute", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540, 600, 610],
        maskOff: [590, 600, 700],
        maskEvents: 6,
        segments: [span(at(540), at(590)), span(at(610), at(700))],
      }),
    );

    expect(built.sessions.map(({ source }) => source)).toEqual(["str", "str"]);
    expect(built.sessionOfSegment).toEqual([1, 2]);
    expect(built.approximate).toBe(true);
  });

  it("creates one session per STR slot and assigns each segment to the overlapping session", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540, 700],
        maskOff: [640, 760],
        maskEvents: 4,
        // STR.edf stores whole minutes, so slot 1 starts 40 s before its first file. A 100 s gap
        // separates slot 1's two files.
        segments: [span(at(540, 40), at(590)), span(at(591, 40), at(640)), span(at(700), at(760))],
      }),
    );

    expect(built.sessions).toEqual([
      { session: 1, start: at(540), end: at(640), source: "str" },
      { session: 2, start: at(700), end: at(760), source: "str" },
    ]);
    expect(built.sessionOfSegment).toEqual([1, 1, 2]);
    expect(built.approximate).toBe(false);
  });

  it("starts slot 0 at noon when it has a mask-off but no mask-on", () => {
    const built = buildSessions(inputs({ maskOn: [Number.NaN], maskOff: [30], maskEvents: 2 }));

    expect(built.sessions).toEqual([{ session: 1, start: at(0), end: at(30), source: "str" }]);
  });

  it("puts a segment that starts 50 s after a session in that session, and makes a derived session for a segment that starts 120 s after it", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540],
        maskOff: [600],
        maskEvents: 2,
        segments: [span(at(600, 50), at(620)), span(at(602), at(630))],
      }),
    );

    expect(built.sessionOfSegment).toEqual([1, 2]);
    expect(built.sessions[1]?.source).toBe("derived");
  });

  it("puts a segment that overlaps two sessions in the session that it overlaps more", () => {
    const built = buildSessions(
      inputs({
        maskOn: [540, 601],
        maskOff: [600, 700],
        maskEvents: 4,
        segments: [span(at(590), at(650))],
      }),
    );

    expect(built.sessionOfSegment).toEqual([2]);
  });

  it("joins segments that match no slot into a derived session when they're 90 s or less apart", () => {
    const slots = Array.from({ length: 10 }, (_, i) => 60 * i);
    const built = buildSessions(
      inputs({
        maskOn: slots,
        maskOff: slots.map((minute) => minute + 30),
        maskEvents: 2 * 12,
        segments: [
          span(at(600), at(620)),
          // This segment starts 90 s after the previous segment ends, so the two join.
          span(at(621, 30), at(640)),
          // This segment starts 91 s after the previous segment ends, so it begins a new session.
          span(at(641, 31), at(660)),
        ],
      }),
    );

    expect(built.sessions.slice(10)).toEqual([
      { session: 11, start: at(600), end: at(640), source: "derived" },
      { session: 12, start: at(641, 31), end: at(660), source: "derived" },
    ]);
    expect(built.sessionOfSegment).toEqual([11, 11, 12]);
    expect(built.approximate).toBe(false);
  });

  it("marks the night approximate when the number of sessions differs from half the machine's count of mask events", () => {
    const built = buildSessions(inputs({ maskOn: [540], maskOff: [600], maskEvents: 6 }));

    expect(built.approximate).toBe(true);
  });
});

describe("assignEvents", () => {
  const sessions = [
    { session: 1, start: at(540), end: at(600), source: "str" as const },
    { session: 2, start: at(700), end: at(760), source: "str" as const },
  ];

  it("puts an event in the session that contains it, with 60 s of slack at either end", () => {
    expect(assignEvents([span(at(550), at(551)), span(at(600, 30), at(601))], sessions)).toEqual([
      { session: 1, outsideMaskOn: false },
      { session: 1, outsideMaskOn: false },
    ]);
  });

  it("puts an event outside every session in the nearest session and marks the event outside mask-on", () => {
    expect(assignEvents([span(at(610), at(611)), span(at(690), at(691))], sessions)).toEqual([
      { session: 1, outsideMaskOn: true },
      { session: 2, outsideMaskOn: true },
    ]);
  });

  it("keeps an event 59 s after session 1 in session 1, and puts an event 61 s before session 2 in session 2, outside mask-on", () => {
    expect(
      assignEvents([span(at(600, 59), at(600, 59)), span(at(698, 59), at(698, 59))], sessions),
    ).toEqual([
      { session: 1, outsideMaskOn: false },
      { session: 2, outsideMaskOn: true },
    ]);
  });

  it("returns a null session for an event on a night with no sessions", () => {
    expect(assignEvents([span(at(550), at(551))], [])).toEqual([
      { session: null, outsideMaskOn: true },
    ]);
  });
});
