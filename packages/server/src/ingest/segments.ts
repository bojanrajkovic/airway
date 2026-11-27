import type { Attributes } from "@opentelemetry/api";
import { toInstant } from "@airway/contract/clock";
import { buildSessions, type Sessions, type Span } from "@airway/contract/derived/sessions";
import type { UsedStrDay } from "@airway/contract/derived/str";
import { FileKind } from "@airway/contract/derived/values";
import type { EdfFileHeaders } from "@airway/edf/header";
import type { FileSizeCheck } from "@airway/edf/size";
import type { AppContext } from "../runtime/context.ts";
import { inSpan } from "../telemetry.ts";
import type { EveFile } from "./events.ts";
import type { ReadyFile, RejectedFile } from "./versions.ts";

/**
 * Narrows `ReadyFile` to a BRP or PLD file whose header and size check the readiness check
 * accepted.
 */
export type SegmentFile = ReadyFile & {
  kind: FileKind.Brp | FileKind.Pld;
  edf: EdfFileHeaders & { size: Exclude<FileSizeCheck, { verdict: "reject" }> };
};

/** Resolves to one night's STR.edf day and its ready BRP, PLD, and EVE files. */
export type NightFiles = {
  night: Temporal.PlainDate;
  /** `toInstant` reads each file header's device-clock start in this home time zone. */
  zone: string;
  day: UsedStrDay;
  /** Lists the BRP and PLD files, which `planSegments` turns into segments. */
  files: readonly SegmentFile[];
  eveFiles: readonly EveFile[];
  /** Lists the night's BRP, PLD, and EVE files that the readiness check rejected. */
  rejected: readonly RejectedFile[];
  /** Lists the night's ready `.crc` files, which go in the night's `files` rows. The worker ignores them. */
  crcFiles: readonly ReadyFile[];
};

/** Resolves to the parts of `NightFiles` that `planSegments` reads. */
export type SegmentInputs = Omit<NightFiles, "eveFiles" | "rejected" | "crcFiles">;

/**
 * Describes the stretch of time that one BRP file recorded, with the PLD files attached to it.
 * Segments are numbered from 1 in time order.
 */
export type NightSegment = Span & {
  segment: number;
  session: number;
  brp: SegmentFile;
  plds: SegmentFile[];
};

/**
 * Reports a file that planSegments left out. The kind is `header_only` for a header-only file,
 * and `unattached_pld` for a PLD file that doesn't match any segment.
 */
export type SegmentWarning =
  | { kind: "header_only"; path: string; fileKind: SegmentFile["kind"] }
  | { kind: "unattached_pld"; path: string; start: Temporal.Instant; end: Temporal.Instant };

export type NightSegments = Pick<Sessions, "sessions" | "approximate"> & {
  segments: NightSegment[];
  warnings: SegmentWarning[];
};

/** Resolves to the segments that `planSegments` built for a night, with the night and its zone. */
export type PlannedNight = Pick<NightFiles, "night" | "zone"> & Pick<NightSegments, "segments">;

type Placed = Span & { file: SegmentFile };

// A file's span starts at its header's device-clock start and covers every whole record on disk.
function place(file: SegmentFile, zone: string): Placed {
  const start = toInstant(file.edf.header.start, zone);
  const milliseconds = Math.round(file.edf.size.records * file.edf.header.recordSeconds * 1000);

  return { file, start, end: start.add({ milliseconds }) };
}

const overlap = (a: Span, b: Span): number =>
  Math.max(
    0,
    Math.min(a.end.epochMilliseconds, b.end.epochMilliseconds) -
      Math.max(a.start.epochMilliseconds, b.start.epochMilliseconds),
  );

/**
 * Plans a night's segments and sessions:
 *
 * - Each BRP file with records is a segment.
 * - Each PLD file with records is assigned to the segment that it overlaps most, or to the earlier
 *   segment on a tie, so both halves of a split PLD file are assigned to the same segment.
 * - `buildSessions` builds the sessions from the night's STR.edf slots and the segments.
 * - A header-only file, or a PLD file that doesn't overlap any segment, is left out with a warning.
 */
export function planSegments({ night, zone, day, files }: SegmentInputs): NightSegments {
  const warnings = files.flatMap((file): SegmentWarning[] =>
    file.edf.size.verdict === "skip"
      ? [{ kind: "header_only", path: file.path, fileKind: file.kind }]
      : [],
  );
  const read = (kind: SegmentFile["kind"]): Placed[] =>
    files
      .filter((file) => file.kind === kind && file.edf.size.verdict === "read")
      .map((file) => place(file, zone))
      .toSorted((a, b) => Temporal.Instant.compare(a.start, b.start));
  const brps = read(FileKind.Brp);
  const plds = brps.map((): SegmentFile[] => []);

  for (const pld of read(FileKind.Pld)) {
    const overlaps = brps.map((brp) => overlap(brp, pld));
    const best = Math.max(0, ...overlaps);

    if (best > 0) {
      plds[overlaps.indexOf(best)]?.push(pld.file);
    } else {
      warnings.push({
        kind: "unattached_pld",
        path: pld.file.path,
        start: pld.start,
        end: pld.end,
      });
    }
  }

  const built = buildSessions({
    night,
    zone,
    maskOn: day.maskOn,
    maskOff: day.maskOff,
    maskEvents: day.maskEvents,
    // Pass bare spans, because buildSessions copies a segment into each derived session.
    segments: brps.map(({ start, end }) => ({ start, end })),
  });

  return {
    sessions: built.sessions,
    approximate: built.approximate,
    warnings,
    segments: brps.map(({ file, start, end }, i) => ({
      segment: i + 1,
      session: built.sessionOfSegment[i] ?? 0,
      start,
      end,
      brp: file,
      plds: plds[i] ?? [],
    })),
  };
}

function warningAttributes(warning: SegmentWarning): Attributes {
  const attributes = {
    "airway.segment_warning.kind": warning.kind,
    "airway.file.path": warning.path,
  };

  return warning.kind === "header_only"
    ? { ...attributes, "airway.file.kind": warning.fileKind }
    : {
        ...attributes,
        "airway.segment_warning.start": warning.start.toString(),
        "airway.segment_warning.end": warning.end.toString(),
      };
}

/**
 * Runs `planSegments` inside an `ingest.segments` span, which records the night and its segment,
 * session, and warning counts. Each warning becomes an `ingest.segment_warning` span event and a
 * `warn` log.
 */
export function buildNight(ctx: Pick<AppContext, "logger">, input: SegmentInputs): NightSegments {
  const night = input.night.toString();
  const logger = ctx.logger.child({ module: "ingest.segments", night });

  return inSpan("ingest.segments", (span) => {
    const planned = planSegments(input);

    span.setAttributes({
      "airway.night": night,
      "airway.segments": planned.segments.length,
      "airway.sessions": planned.sessions.length,
      "airway.sessions.approximate": planned.approximate,
      "airway.segment_warnings": planned.warnings.length,
    });

    for (const warning of planned.warnings) {
      span.addEvent("ingest.segment_warning", warningAttributes(warning));
      logger.warn({ warning }, "Segment warning");
    }

    return planned;
  });
}
