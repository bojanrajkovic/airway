import { toInstant } from "@airway/contract/clock";
import { buildSessions, type Sessions, type Span } from "@airway/contract/derived/sessions";
import type { UsedStrDay } from "@airway/contract/derived/str";
import type { EdfFile } from "@airway/edf/header";
import type { FileSizeCheck } from "@airway/edf/size";
import type { ReadyFile } from "./versions.ts";

/** A ready BRP or PLD file, with the header and size check that readiness accepted. */
export type SegmentFile = ReadyFile & {
  kind: "brp" | "pld";
  edf: EdfFile & { size: Exclude<FileSizeCheck, { verdict: "reject" }> };
};

/** One night's inputs: its STR.edf day and its ready BRP and PLD files. */
export type NightFiles = {
  night: Temporal.PlainDate;
  /** The home time zone, whose winter offset converts the device clock. */
  zone: string;
  day: UsedStrDay;
  files: readonly SegmentFile[];
};

/** One BRP file's stretch of recording, numbered from 1 in time order, with the PLD files on it. */
export type NightSegment = Span & {
  segment: number;
  session: number;
  brp: SegmentFile;
  plds: SegmentFile[];
};

/** A file planSegments leaves out of every segment. */
export type SegmentWarning =
  | { kind: "header_only"; path: string; fileKind: SegmentFile["kind"] }
  | { kind: "unattached_pld"; path: string; start: Temporal.Instant; end: Temporal.Instant };

export type NightSegments = Pick<Sessions, "sessions" | "approximate"> & {
  segments: NightSegment[];
  warnings: SegmentWarning[];
};

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
 * A night's segments and sessions. Each BRP file with records is a segment. Each PLD file with
 * records attaches to the segment it overlaps most, the earlier one on a tie, so both halves of a
 * split PLD land on one segment. `buildSessions` then builds the sessions from the night's STR.edf
 * slots and the segments. planSegments leaves out a header-only file, or a PLD file that overlaps
 * no segment, and warns about it.
 */
export function planSegments({ night, zone, day, files }: NightFiles): NightSegments {
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
  const brps = read("brp");
  const plds = brps.map((): SegmentFile[] => []);

  for (const pld of read("pld")) {
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

  const { sessions, segmentSessions, approximate } = buildSessions({
    night,
    zone,
    maskOn: day.maskOn,
    maskOff: day.maskOff,
    maskEvents: day.maskEvents,
    // Pass bare spans, because buildSessions copies a segment into each derived session.
    segments: brps.map(({ start, end }) => ({ start, end })),
  });

  return {
    sessions,
    approximate,
    warnings,
    segments: brps.map(({ file, start, end }, i) => ({
      segment: i + 1,
      session: segmentSessions[i] ?? 0,
      start,
      end,
      brp: file,
      plds: plds[i] ?? [],
    })),
  };
}
