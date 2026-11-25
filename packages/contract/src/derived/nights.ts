import type { RuleSet } from "../profile.ts";
import type { EventRow, NightRow } from "./rows.ts";
import type { Sessions } from "./sessions.ts";
import type { UsedStrDay } from "./str.ts";
import type { EVENT_TYPES } from "./values.ts";

type EventType = (typeof EVENT_TYPES)[number];

/** The event-row fields that `nightRow` and `ahiCheck` read. */
export type NightEvent = Pick<EventRow, "type" | "outside_mask_on">;

/** The event types that count toward the AHI. */
const AHI_EVENTS: ReadonlySet<EventType> = new Set([
  "obstructive_apnea",
  "central_apnea",
  "unclassified_apnea",
  "hypopnea",
]);

/**
 * The result of comparing the AHI that airway computes from the night's events with the machine's
 * AHI. Both values are in tenths.
 */
export type AhiCheck =
  | { outcome: "match"; tenths: number }
  | { outcome: "mismatch"; computed: number; machine: number | null }
  | { outcome: "no_usage" };

/**
 * Recomputes the night's AHI from the night's apneas and hypopneas, including those outside mask-on
 * time, and compares the result with STR.edf's AHI. airway's index in tenths is 600 × events ÷
 * usage, rounded down. Usage is in whole minutes, so the math stays in integers. The machine's AHI
 * is rounded to tenths to drop float noise. Returns `no_usage` when usage is 0 or missing.
 */
export function ahiCheck(day: UsedStrDay, events: readonly NightEvent[]): AhiCheck {
  const usage = day.signals["usage"] ?? 0;

  if (usage <= 0) {
    return { outcome: "no_usage" };
  }

  const scored = events.filter((event) => AHI_EVENTS.has(event.type)).length;
  const computed = Math.floor((600 * scored) / usage);
  const ahi = day.signals["ahi"] ?? null;
  const machine = ahi === null ? null : Math.round(ahi * 10);

  return computed === machine
    ? { outcome: "match", tenths: computed }
    : { outcome: "mismatch", computed, machine };
}

export type NightInputs = {
  day: UsedStrDay;
  sessions: Pick<Sessions, "sessions" | "approximate">;
  events: readonly NightEvent[];
  ruleSet: RuleSet;
};

/** `nightRow` returns the night's row and the full AHI check, which ingest logs on a mismatch. */
export type ScoredNight = { row: Omit<NightRow, "arrived_at">; ahi: AhiCheck };

/**
 * Builds a night's row from the night's STR.edf day, sessions, event rows, and rule set.
 * `longest_stretch` is the length of the longest session in minutes, or 0 on a night with no
 * sessions.
 */
export function nightRow({ day, sessions, events, ruleSet }: NightInputs): ScoredNight {
  const count = (type: EventType): number => events.filter((event) => event.type === type).length;
  const ahi = ahiCheck(day, events);

  return {
    row: {
      night: day.day,
      signals: day.signals,
      sessions: sessions.sessions.length,
      expected_sessions: Math.floor(day.maskEvents / 2),
      session_count_approximate: sessions.approximate,
      longest_stretch: Math.max(
        0,
        ...sessions.sessions.map(({ start, end }) => start.until(end).total("minutes")),
      ),
      obstructive_apneas: count("obstructive_apnea"),
      central_apneas: count("central_apnea"),
      unclassified_apneas: count("unclassified_apnea"),
      hypopneas: count("hypopnea"),
      arousals: count("arousal"),
      events_outside_mask_on: events.filter((event) => event.outside_mask_on).length,
      ahi_check: ahi.outcome,
      rule_set: ruleSet,
    },
    ahi,
  };
}
