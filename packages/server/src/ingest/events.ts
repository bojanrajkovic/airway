import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Span as OtelSpan } from "@opentelemetry/api";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { toInstant } from "@airway/contract/clock";
import { nightRow, type ScoredNight } from "@airway/contract/derived/nights";
import type { EventRow } from "@airway/contract/derived/rows";
import { assignEvents, type Session, type Sessions } from "@airway/contract/derived/sessions";
import type { UsedStrDay } from "@airway/contract/derived/str";
import { EVENT_TYPES } from "@airway/contract/derived/values";
import { ruleSetFor } from "@airway/contract/profile";
import { EVENT_LABELS } from "@airway/edf/airsense";
import { readAnnotations, type Annotation } from "@airway/edf/annotations";
import { isReadable, type EdfFile, type EdfReadError } from "@airway/edf/header";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import type { ReadyFile } from "./versions.ts";

/** An EVE file that passed the readiness check. `edf` is the header that the check read. */
export type EveFile = ReadyFile & { kind: "eve"; edf: EdfFile };

/** The input to `scoreNight` for one night. `buildNight` produces `sessions`. */
export type NightEvents = {
  night: Temporal.PlainDate;
  /** The home time zone. */
  zone: string;
  day: UsedStrDay;
  files: readonly EveFile[];
  sessions: Pick<Sessions, "sessions" | "approximate">;
};

/** The error from reading or parsing an EVE file, with the file's path. */
export type EventFileError = EdfReadError & { path: string };

/** `nightRow`'s result, plus the night's event rows. */
export type ScoredEvents = ScoredNight & { events: EventRow[] };

/**
 * The annotations that `readEve` read from one EVE file. Each onset is the number of seconds after
 * `start`, which is the file's start time.
 */
export type FileAnnotations = {
  path: string;
  start: Temporal.Instant;
  annotations: readonly Annotation[];
};

/**
 * An EVE label that airway doesn't recognize, with the file's path and the number of times the
 * label appears in that file.
 */
export type UnknownLabel = { label: string; path: string; count: number };

export type PlacedEvents = { events: EventRow[]; unknownLabels: UnknownLabel[] };

type EventType = (typeof EVENT_TYPES)[number];

/** Maps each EVE label, in lowercase, to its event type. */
const EVENT_TYPE_OF: ReadonlyMap<string, EventType> = new Map(
  EVENT_TYPES.flatMap((type) =>
    type === "other" ? [] : [[EVENT_LABELS[type].toLowerCase(), type] as const],
  ),
);

const RECORDING_STARTS = "recording starts";

/**
 * Converts a night's EVE annotations into event rows sorted by time, and uses `assignEvents` to
 * place each row in a session. Label matching ignores case. `toEvents` drops "Recording starts",
 * turns any label that it doesn't recognize into an `other` event, and keeps the original text in
 * the event's `label`. `unknownLabels` lists each of those labels once per file, with the number
 * of times it appears in that file. An onset marks the end of an event, so a row's `ts` is the
 * annotation's onset minus its duration. The machine writes a duration of 0 for the events that
 * it doesn't time, such as hypopneas and arousals, and `toEvents` stores that 0 as null.
 */
export function toEvents(
  night: Temporal.PlainDate,
  files: readonly FileAnnotations[],
  sessions: readonly Session[],
): PlacedEvents {
  const unknown = new Map<string, UnknownLabel>();
  const read = files
    .flatMap(({ path, start, annotations }) =>
      annotations.flatMap(({ onset, duration, label }) => {
        if (label.toLowerCase() === RECORDING_STARTS) {
          return [];
        }

        const type = EVENT_TYPE_OF.get(label.toLowerCase()) ?? "other";

        if (type === "other") {
          const key = JSON.stringify([path, label]);
          const seen = unknown.get(key);

          unknown.set(key, { label, path, count: (seen?.count ?? 0) + 1 });
        }

        const ts = start.add({ milliseconds: Math.round((onset - duration) * 1000) });

        return [{ ts, duration: duration === 0 ? null : duration, type, label }];
      }),
    )
    .toSorted((a, b) => Temporal.Instant.compare(a.ts, b.ts));
  const places = assignEvents(
    read.map(({ ts, duration }) => ({
      start: ts,
      end: ts.add({ milliseconds: Math.round((duration ?? 0) * 1000) }),
    })),
    sessions,
  );

  return {
    events: read.map((event, i) => ({
      night,
      session: places[i]?.session ?? null,
      ...event,
      source: "resmed",
      outside_mask_on: places[i]?.outsideMaskOn ?? true,
    })),
    unknownLabels: [...unknown.values()],
  };
}

// Reads one EVE file's annotations, and returns an empty list for a header-only file.
function readEve(
  root: string,
  zone: string,
  file: EveFile,
): ResultAsync<FileAnnotations, EventFileError> {
  const { path, edf } = file;
  const start = toInstant(edf.header.start, zone);

  if (!isReadable(edf)) {
    return okAsync({ path, start, annotations: [] });
  }

  return ResultAsync.fromPromise(readFile(join(root, path)), (cause): EventFileError => ({
    kind: "read_failed",
    path,
    message: cause instanceof Error ? cause.message : String(cause),
  })).andThen((bytes) =>
    readAnnotations(bytes, edf)
      .map((annotations) => ({ path, start, annotations }))
      .mapErr((error): EventFileError => ({ ...error, path })),
  );
}

// Adds a span event and logs a warning for each unknown label and for an AHI mismatch.
function report(span: OtelSpan, logger: Logger, placed: PlacedEvents, scored: ScoredNight): void {
  for (const { label, path, count } of placed.unknownLabels) {
    span.addEvent("ingest.unknown_event_label", {
      "airway.event.label": label,
      "airway.file.path": path,
      "airway.event.count": count,
    });
    logger.warn({ label, path, count }, "Unknown event label");
  }

  if (scored.ahi.outcome === "mismatch") {
    const { computed, machine } = scored.ahi;

    span.addEvent("ingest.ahi_mismatch", {
      "airway.ahi.computed_tenths": computed,
      ...(machine === null ? {} : { "airway.ahi.machine_tenths": machine }),
    });
    logger.warn({ computed, machine }, "AHI mismatch");
  }
}

/**
 * Reads a night's EVE files, places the events in the night's sessions, and builds the night's
 * row, all inside an `ingest.events` span. The span records the night, the number of EVE files, the
 * number of events, and the result of the AHI check. `scoreNight` adds a span event and logs a
 * warning for each unknown label and for an AHI mismatch. If an EVE file fails to read or parse,
 * `scoreNight` returns an `EventFileError`, adds an `ingest.event_file_failed` span event, and logs
 * the error.
 */
export function scoreNight(
  ctx: AppContext,
  input: NightEvents,
): ResultAsync<ScoredEvents, EventFileError> {
  const { night, zone, day, files, sessions } = input;
  const logger = ctx.logger.child({ module: "ingest.events", night: night.toString() });

  return inSpanAsync("ingest.events", (span) => {
    span.setAttributes({ "airway.night": night.toString(), "airway.event_files": files.length });

    return ResultAsync.combine(files.map((file) => readEve(ctx.config.cpapDataPath, zone, file)))
      .orElse((error) => {
        span.addEvent("ingest.event_file_failed", {
          "airway.file.path": error.path,
          "error.type": error.kind,
        });
        logger.error({ error }, "EVE file failed to read or parse");

        return errAsync(error);
      })
      .map((annotations) => {
        const placed = toEvents(night, annotations, sessions.sessions);
        const scored = nightRow({
          day,
          sessions,
          events: placed.events,
          ruleSet: ruleSetFor(night, ctx.config.patient),
        });

        span.setAttributes({
          "airway.events": placed.events.length,
          "airway.ahi_check": scored.ahi.outcome,
        });
        report(span, logger, placed, scored);

        return { ...scored, events: placed.events };
      });
  });
}
