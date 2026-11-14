import type { ClockOffset } from "../clock.ts";
import type { SESSION_SOURCES } from "./values.ts";

/** A stretch of time, such as a BRP segment or an event. */
export type Span = { start: Temporal.Instant; end: Temporal.Instant };

/** A mask-on period, numbered from 1 in time order. */
export type Session = Span & { session: number; source: (typeof SESSION_SOURCES)[number] };

export type SessionInputs = {
  night: Temporal.PlainDate;
  /** The night's clock offset, which turns STR.edf's device-clock minutes into instants. */
  offset: ClockOffset;
  /** STR.edf's MaskOn and MaskOff slots: minutes since noon on the device clock, NaN when unused. */
  maskOn: readonly number[];
  maskOff: readonly number[];
  /** STR.edf's MaskEvents: two per mask-on period, including periods past the 10 slots. */
  maskEvents: number;
  /** The night's BRP segments, in time order. */
  segments: readonly Span[];
};

export type Sessions = {
  sessions: Session[];
  /** The session each segment belongs to, in the order of `segments`. */
  segmentSessions: number[];
  /** True when the sessions can't add up to MaskEvents / 2. */
  approximate: boolean;
};

// A segment or event this close to a session counts as inside it.
const SLACK_SECONDS = 60;
// Leftover segments this close together are one mask-on period.
const JOIN_SECONDS = 90;

const seconds = (from: Temporal.Instant, to: Temporal.Instant): number =>
  from.until(to).total("seconds");

// How long `span` overlaps `session` widened by the slack, in seconds; 0 when they don't meet.
function overlap(span: Span, session: Span): number {
  const slack = SLACK_SECONDS * 1000;
  const start = Math.max(span.start.epochMilliseconds, session.start.epochMilliseconds - slack);
  const end = Math.min(span.end.epochMilliseconds, session.end.epochMilliseconds + slack);

  return Math.max(0, (end - start) / 1000);
}

// STR.edf's used slots as spans. A slot 0 with a mask-off but no mask-on started before noon, so
// it starts at noon (OSCAR's fix for the night's first period).
function slotSpans({ night, offset, maskOn, maskOff }: SessionInputs): Span[] {
  const noon = night.toPlainDateTime("12:00").toZonedDateTime(offset.utcOffset).toInstant();
  const instant = (minutes: number): Temporal.Instant => noon.add({ minutes });

  return maskOff.flatMap((off, slot): Span[] => {
    const on =
      slot === 0 && Number.isNaN(maskOn[slot] ?? Number.NaN) ? 0 : (maskOn[slot] ?? Number.NaN);

    return Number.isNaN(on) || Number.isNaN(off) ? [] : [{ start: instant(on), end: instant(off) }];
  });
}

/**
 * A night's sessions, built the way ingest builds them:
 *
 * 1. Each used STR.edf slot is a `str` session.
 * 2. Each segment joins the `str` session it overlaps most, allowing 60 s on either side.
 * 3. Segments that match no slot, such as those past the 10 slots, join their neighbor when the gap
 *    is 90 s or less, and each run is a `derived` session.
 *
 * Sessions are numbered from 1 in time order.
 */
export function buildSessions(inputs: SessionInputs): Sessions {
  const candidates: Candidate[] = slotSpans(inputs).map((span) => ({
    span,
    source: "str",
    members: [],
  }));
  const strCount = candidates.length;
  let run: Candidate | undefined = undefined;

  inputs.segments.forEach((segment, i) => {
    const overlaps = candidates.slice(0, strCount).map(({ span }) => overlap(segment, span));
    const best = Math.max(0, ...overlaps);

    if (best > 0) {
      candidates[overlaps.indexOf(best)]?.members.push(i);
    } else if (run !== undefined && seconds(run.span.end, segment.start) <= JOIN_SECONDS) {
      run.span = { start: run.span.start, end: segment.end };
      run.members.push(i);
    } else {
      run = { span: { ...segment }, source: "derived", members: [i] };
      candidates.push(run);
    }
  });

  const ordered = candidates.toSorted((a, b) =>
    Temporal.Instant.compare(a.span.start, b.span.start),
  );
  const segmentSessions = inputs.segments.map(() => 0);

  ordered.forEach(({ members }, i) => {
    for (const member of members) {
      segmentSessions[member] = i + 1;
    }
  });

  return {
    sessions: ordered.map(({ span, source }, i) => ({ session: i + 1, ...span, source })),
    segmentSessions,
    approximate: ordered.length !== inputs.maskEvents / 2,
  };
}

type Candidate = { span: Span; source: Session["source"]; members: number[] };

/** Where an event belongs: its session, and whether it fell outside every mask-on period. */
export type EventPlace = { session: number | null; outsideMaskOn: boolean };

/**
 * Each event goes to the session that contains it, allowing 60 s on either side. Otherwise it goes
 * to the nearest session, marked outside mask-on, so the sessions' counts add up to the night's. On
 * a night with no sessions, an event has no session.
 */
export function assignEvents(events: readonly Span[], sessions: readonly Session[]): EventPlace[] {
  return events.map((event): EventPlace => {
    const inside = sessions.find(
      ({ start, end }) =>
        seconds(start, event.start) >= -SLACK_SECONDS && seconds(event.end, end) >= -SLACK_SECONDS,
    );

    if (inside !== undefined) {
      return { session: inside.session, outsideMaskOn: false };
    }

    const distance = ({ start, end }: Span): number =>
      Math.max(seconds(event.end, start), seconds(end, event.start), 0);
    const nearest = sessions.reduce<Session | undefined>(
      (best, session) =>
        best === undefined || distance(session) < distance(best) ? session : best,
      undefined,
    );

    return { session: nearest?.session ?? null, outsideMaskOn: true };
  });
}
