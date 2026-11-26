import { toInstant } from "../clock.ts";
import type { UsedStrDay } from "./str.ts";
import { SessionSource } from "./values.ts";

/** Describes a stretch of time, such as a BRP segment or an event. */
export type Span = { start: Temporal.Instant; end: Temporal.Instant };

/** Describes a mask-on period. Sessions are numbered from 1 in time order. */
export type Session = Span & { session: number; source: SessionSource };

/** `buildSessions` reads a night's STR.edf slots and mask events, and its BRP segments. */
export type SessionInputs = Pick<UsedStrDay, "maskOn" | "maskOff" | "maskEvents"> & {
  night: Temporal.PlainDate;
  /** `zone` is the home time zone. */
  zone: string;
  /** `segments` contains the night's BRP segments, in time order. */
  segments: readonly Span[];
};

export type Sessions = {
  sessions: Session[];
  /** Maps each segment, in the order of `segments`, to the session that it belongs to. */
  sessionOfSegment: number[];
  /** `approximate` is true when the number of sessions differs from MaskEvents / 2. */
  approximate: boolean;
};

// A segment or event this close to a session counts as inside it.
const SLACK_SECONDS = 60;
// Leftover segments this close together are one mask-on period.
const JOIN_SECONDS = 90;

const seconds = (from: Temporal.Instant, to: Temporal.Instant): number =>
  from.until(to).total("seconds");

// Returns the seconds that `span` overlaps `session`, after widening `session` by the slack on each
// side. Returns 0 when they don't overlap.
function overlap(span: Span, session: Span): number {
  const slack = SLACK_SECONDS * 1000;
  const start = Math.max(span.start.epochMilliseconds, session.start.epochMilliseconds - slack);
  const end = Math.min(span.end.epochMilliseconds, session.end.epochMilliseconds + slack);

  return Math.max(0, (end - start) / 1000);
}

// Returns STR.edf's used slots as spans. Slot 0 without a mask-on starts at noon, as in OSCAR.
function slotSpans({ night, zone, maskOn, maskOff }: SessionInputs): Span[] {
  const noon = toInstant(night.toPlainDateTime("12:00"), zone);
  const instant = (minutes: number): Temporal.Instant => noon.add({ minutes });

  return maskOff.flatMap((off, slot): Span[] => {
    const on =
      slot === 0 && Number.isNaN(maskOn[slot] ?? Number.NaN) ? 0 : (maskOn[slot] ?? Number.NaN);

    return Number.isNaN(on) || Number.isNaN(off) || on === off
      ? []
      : [{ start: instant(on), end: instant(off) }];
  });
}

/** Builds a night's sessions from STR.edf's slots and BRP segments, as docs/ingest.md describes. */
export function buildSessions(inputs: SessionInputs): Sessions {
  const candidates: Candidate[] = slotSpans(inputs).map((span) => ({
    span,
    source: SessionSource.Str,
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
      run = { span: { ...segment }, source: SessionSource.Derived, members: [i] };
      candidates.push(run);
    }
  });

  const ordered = candidates.toSorted((a, b) =>
    Temporal.Instant.compare(a.span.start, b.span.start),
  );
  const sessionOfSegment = inputs.segments.map(() => 0);

  ordered.forEach(({ members }, i) => {
    for (const member of members) {
      sessionOfSegment[member] = i + 1;
    }
  });

  return {
    sessions: ordered.map(({ span, source }, i) => ({ session: i + 1, ...span, source })),
    sessionOfSegment,
    approximate: ordered.length !== inputs.maskEvents / 2,
  };
}

type Candidate = { span: Span; source: Session["source"]; members: number[] };

/** Describes an event's session, and whether the event fell outside every mask-on period. */
export type EventPlace = { session: number | null; outsideMaskOn: boolean };

/** Returns each event's session, as docs/ingest.md describes. */
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
