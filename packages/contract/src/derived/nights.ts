import type { RuleSet } from "../profile.ts";
import type { EventRow, FileRow, NightRow } from "./rows.ts";
import type { Sessions } from "./sessions.ts";
import type { UsedStrDay } from "./str.ts";
import { AhiOutcome, EventType, FileChecksum } from "./values.ts";

/** Picks the event-row fields that `nightRow` and `ahiCheck` read. */
export type NightEvent = Pick<EventRow, "type" | "outside_mask_on">;

/** `ahiCheck` counts these event types toward the AHI. */
const AHI_EVENTS: ReadonlySet<EventType> = new Set([
  EventType.ObstructiveApnea,
  EventType.CentralApnea,
  EventType.UnclassifiedApnea,
  EventType.Hypopnea,
]);

/**
 * Describes the result of comparing the AHI that airway computes from the night's events with the
 * machine's AHI. Both values are in tenths.
 */
export type AhiCheck =
  | { outcome: AhiOutcome.Match; tenths: number }
  | { outcome: AhiOutcome.Mismatch; computed: number; machine: number | null }
  | { outcome: AhiOutcome.NoUsage };

/**
 * Recomputes the night's AHI from the night's apneas and hypopneas, including those outside mask-on
 * time, and compares the result with STR.edf's AHI. airway's index in tenths is 600 × events ÷
 * usage, rounded down. Usage is in whole minutes, so the math stays in integers. The machine's AHI
 * is rounded to tenths to drop float noise. Returns `no_usage` when usage is 0 or missing.
 */
export function ahiCheck(day: UsedStrDay, events: readonly NightEvent[]): AhiCheck {
  const usage = day.signals["usage"] ?? 0;

  if (usage <= 0) {
    return { outcome: AhiOutcome.NoUsage };
  }

  const scored = events.filter((event) => AHI_EVENTS.has(event.type)).length;
  const computed = Math.floor((600 * scored) / usage);
  const ahi = day.signals["ahi"] ?? null;
  const machine = ahi === null ? null : Math.round(ahi * 10);

  return computed === machine
    ? { outcome: AhiOutcome.Match, tenths: computed }
    : { outcome: AhiOutcome.Mismatch, computed, machine };
}

export type NightInputs = {
  day: UsedStrDay;
  sessions: Pick<Sessions, "sessions" | "approximate">;
  events: readonly NightEvent[];
  ruleSet: RuleSet;
};

/** `nightRow` returns the night's row and the full AHI check, which ingest logs on a mismatch. */
export type ScoredNight = {
  row: Omit<NightRow, "arrived_at" | "possibly_corrupted">;
  ahi: AhiCheck;
};

/**
 * Returns true when one of the night's files:
 *
 * - doesn't match its `.crc`
 * - has a record whose Crc16 doesn't match
 * - failed `checkFileSize`
 *
 * `files` lists the night's BRP, PLD, and EVE files that ingest imported. `rejected` counts the
 * night's BRP, PLD, and EVE files that `checkFileSize` rejected.
 */
export function possiblyCorrupted(
  files: readonly Pick<FileRow, "checksum" | "bad_records">[],
  rejected: number,
): boolean {
  return (
    rejected > 0 ||
    files.some(
      ({ checksum, bad_records }) =>
        checksum === FileChecksum.Mismatch || (bad_records !== null && bad_records > 0),
    )
  );
}

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
      obstructive_apneas: count(EventType.ObstructiveApnea),
      central_apneas: count(EventType.CentralApnea),
      unclassified_apneas: count(EventType.UnclassifiedApnea),
      hypopneas: count(EventType.Hypopnea),
      arousals: count(EventType.Arousal),
      events_outside_mask_on: events.filter((event) => event.outside_mask_on).length,
      ahi_check: ahi.outcome,
      rule_set: ruleSet,
    },
    ahi,
  };
}
