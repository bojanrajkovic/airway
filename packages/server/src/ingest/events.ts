import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Span as OtelSpan } from "@opentelemetry/api";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { toInstant } from "@airway/contract/clock";
import { nightRow, type ScoredNight } from "@airway/contract/derived/nights";
import type { EventRow } from "@airway/contract/derived/rows";
import { assignEvents, type Session, type Sessions } from "@airway/contract/derived/sessions";
import type { UsedStrDay } from "@airway/contract/derived/str";
import type { EVENT_TYPES } from "@airway/contract/derived/values";
import { ruleSetFor } from "@airway/contract/profile";
import { readAnnotations, type Annotation } from "@airway/edf/annotations";
import { isReadable, type EdfFile, type EdfReadError } from "@airway/edf/header";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import type { ReadyFile } from "./versions.ts";

/** A ready EVE file, with the header the readiness check read. */
export type EveFile = ReadyFile & { kind: "eve"; edf: EdfFile };

/** One night's inputs: its STR.edf day, its ready EVE files, and the sessions `buildNight` built. */
export type NightEvents = {
  night: Temporal.PlainDate;
  /** The home time zone, whose winter offset converts the device clock. */
  zone: string;
  day: UsedStrDay;
  files: readonly EveFile[];
  sessions: Pick<Sessions, "sessions" | "approximate">;
};

/** An EVE file that failed to read or parse, with its path. */
export type EventFileError = EdfReadError & { path: string };

/** A night's event rows, its row without `arrived_at`, and the AHI check behind its `ahi_check`. */
export type ScoredEvents = ScoredNight & { events: EventRow[] };

/** One EVE file's annotations, with the file's start. Onsets are seconds from that start. */
export type FileAnnotations = {
  path: string;
  start: Temporal.Instant;
  annotations: readonly Annotation[];
};

/** A label no event type matches, the file it came from, and how often that file has it. */
export type UnknownLabel = { label: string; path: string; count: number };

export type PlacedEvents = { events: EventRow[]; unknownLabels: UnknownLabel[] };

type EventType = (typeof EVENT_TYPES)[number];

/** How EVE labels each event type, keyed in lowercase. */
const EVENT_TYPE_OF: ReadonlyMap<string, EventType> = new Map([
  ["obstructive apnea", "obstructive_apnea"],
  ["central apnea", "central_apnea"],
  ["apnea", "unclassified_apnea"],
  ["hypopnea", "hypopnea"],
  ["arousal", "arousal"],
]);

const RECORDING_STARTS = "recording starts";

/**
 * Turns a night's EVE annotations into event rows, in time order, each placed in a session by
 * `assignEvents`. Labels match whatever their case. "Recording starts" is dropped, and any other
 * label becomes `other` with its text, listed once per file in `unknownLabels` with its count. An
 * onset marks the event's end, so an event starts at its onset minus its duration. A duration of 0
 * becomes null, because the machine doesn't time hypopneas or arousals.
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

// One EVE file's annotations. A header-only file has none.
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

// Span events and warn logs for what scoring found: unknown labels and an AHI mismatch.
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
 * Reads a night's EVE files, places their events in its sessions, and builds its row, inside an
 * `ingest.events` span. The span records the night, the file and event counts, and the AHI check.
 * Each unknown label and an AHI mismatch add a span event and a `warn` log. An EVE file that fails
 * to read or parse fails the night, with an `ingest.event_file_failed` span event and an `error`
 * log, so a night never imports with only some of its events.
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
