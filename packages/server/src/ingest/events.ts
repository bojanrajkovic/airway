import type { Span as OtelSpan } from "@opentelemetry/api";
import { errAsync, ResultAsync } from "neverthrow";
import { toInstant } from "@airway/contract/clock";
import { nightRow, type ScoredNight } from "@airway/contract/derived/nights";
import type { EventRow } from "@airway/contract/derived/rows";
import { assignEvents, type Session, type Sessions } from "@airway/contract/derived/sessions";
import type { UsedStrDay } from "@airway/contract/derived/str";
import { AhiOutcome, EventSource, EventType, type FileKind } from "@airway/contract/derived/values";
import { valuesOf } from "@airway/contract/enum";
import { ruleSetFor } from "@airway/contract/profile";
import { AIRSENSE, EVENT_LABELS } from "@airway/edf/airsense";
import type { EdfAnnotation } from "@airway/edf/annotations";
import type { EdfFileHeaders } from "@airway/edf/header";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { readEdfFile, type CheckedFile, type EdfFileError, type FileCheck } from "./edf.ts";
import type { ReadyFile } from "./versions.ts";

/**
 * Describes an EVE file that passed the readiness check. `edf` is the header that the check
 * read.
 */
export type EveFile = ReadyFile & { kind: FileKind.Eve; edf: EdfFileHeaders };

/** Describes one night's input to `scoreNight`. `buildNight` produces `sessions`. */
export type NightEvents = {
  night: Temporal.PlainDate;
  /** `toInstant` reads each EVE header's device-clock start in this home time zone. */
  zone: string;
  day: UsedStrDay;
  files: readonly EveFile[];
  sessions: Pick<Sessions, "sessions" | "approximate">;
};

/** Adds the night's event rows and each EVE file's checksum checks to the result of `nightRow`. */
export type ScoredEvents = ScoredNight & { events: EventRow[]; checks: FileCheck[] };

/**
 * Describes the annotations that `readEve` read from one EVE file. Each onset is the number of
 * seconds after `start`, which is the file's start time.
 */
export type FileAnnotations = {
  path: string;
  start: Temporal.Instant;
  annotations: readonly EdfAnnotation[];
};

/**
 * Records how many times an EVE label that airway doesn't recognize appears in one EVE file.
 */
export type UnknownLabel = { label: string; path: string; count: number };

export type PlacedEvents = { events: EventRow[]; unknownLabels: UnknownLabel[] };

/** Maps each EVE label, in lowercase, to its event type. */
const EVENT_TYPE_OF: ReadonlyMap<string, EventType> = new Map(
  valuesOf(EventType).flatMap((type) =>
    type === EventType.Other ? [] : [[EVENT_LABELS[type].toLowerCase(), type] as const],
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

        const type = EVENT_TYPE_OF.get(label.toLowerCase()) ?? EventType.Other;

        if (type === EventType.Other) {
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
      source: EventSource.Resmed,
      outside_mask_on: places[i]?.outsideMaskOn ?? true,
    })),
    unknownLabels: [...unknown.values()],
  };
}

// Reads one EVE file's annotations. `readEdf` returns an empty list for a header-only file.
function readEve(
  ctx: Pick<AppContext, "config" | "logger">,
  zone: string,
  file: EveFile,
): ResultAsync<CheckedFile<FileAnnotations>, EdfFileError> {
  const { path } = file;

  return readEdfFile(ctx, path, AIRSENSE.eve).map(({ file: { header, annotations }, check }) => ({
    file: { path, start: toInstant(header.start, zone), annotations },
    check,
  }));
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

  if (scored.ahi.outcome === AhiOutcome.Mismatch) {
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
 * `scoreNight` returns an `EdfFileError`, adds an `ingest.event_file_failed` span event, and logs
 * the error.
 */
export function scoreNight(
  ctx: Pick<AppContext, "config" | "logger">,
  input: NightEvents,
): ResultAsync<ScoredEvents, EdfFileError> {
  const { night, zone, day, files, sessions } = input;
  const logger = ctx.logger.child({ module: "ingest.events", night: night.toString() });

  return inSpanAsync("ingest.events", (span) => {
    span.setAttributes({ "airway.night": night.toString(), "airway.event_files": files.length });

    return ResultAsync.combine(files.map((file) => readEve(ctx, zone, file)))
      .orElse((error) => {
        span.addEvent("ingest.event_file_failed", {
          "airway.file.path": error.path,
          "error.type": error.kind,
        });
        logger.error({ error }, "EVE file failed to read or parse");

        return errAsync(error);
      })
      .map((read) => {
        const placed = toEvents(
          night,
          read.map(({ file }) => file),
          sessions.sessions,
        );
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

        return { ...scored, events: placed.events, checks: read.map(({ check }) => check) };
      });
  });
}
