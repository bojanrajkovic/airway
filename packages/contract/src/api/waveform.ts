import { z } from "zod";
import { Instant, PlainDate } from "../dates.ts";
import type { EVENT_TYPES } from "../derived/values.ts";

/** The widest plot the viewer asks buckets for, in pixels. */
export const MAX_WAVEFORM_BUCKETS = 4000;

/**
 * What `waveform.window` takes: a stretch of one night, and how many buckets to split it into,
 * which the viewer sets to the plot's width in pixels.
 */
export const WaveformWindow = z
  .strictObject({
    night: PlainDate,
    from: Instant,
    to: Instant,
    buckets: z.number().int().min(1).max(MAX_WAVEFORM_BUCKETS),
  })
  .refine(({ from, to }) => Temporal.Instant.compare(from, to) < 0, {
    error: "`from` must be before `to`",
  });
export type WaveformWindow = z.infer<typeof WaveformWindow>;

/** What `waveform.night` takes. */
export const WaveformNight = z.strictObject({ night: PlainDate });
export type WaveformNight = z.infer<typeof WaveformNight>;

/** The viewer's lanes: flow and pressure from BRP at 25 Hz, leak and flow limitation from PLD at 2 s. */
export const WAVEFORM_LANES = ["flow", "pressure", "leak", "flow_limitation"] as const;
export type WaveformLane = (typeof WAVEFORM_LANES)[number];

/**
 * One recording file's stretch of a lane. Values are evenly spaced from `start`, `step`
 * milliseconds apart. While a bucket holds more than two samples, each point is its bucket's
 * lowest and highest value. When a bucket holds two samples or fewer, the points are the raw
 * samples.
 */
export type WaveformPiece = { start: Temporal.Instant; step: number } & (
  | { kind: "range"; min: number[]; max: number[] }
  | { kind: "samples"; values: number[] }
);

/** A lane in its stored unit. Pieces never join across a gap between files, so the line breaks. */
export type WaveformSeries = { unit: string; pieces: WaveformPiece[] };

type EventType = (typeof EVENT_TYPES)[number];
/** An event the machine flagged. `duration` is in seconds, and null for an event without one. */
export type WaveformEvent = { ts: Temporal.Instant; type: EventType; duration: number | null };

/** What `waveform.window` returns. */
export type WaveformData = {
  lanes: Record<WaveformLane, WaveformSeries>;
  /** The events that overlap the window. */
  events: WaveformEvent[];
};

/** What `waveform.night` returns: the whole-night strip above the lanes. */
export type WaveformOverview = {
  night: Temporal.PlainDate;
  sessions: { from: Temporal.Instant; to: Temporal.Instant }[];
  /** The time ranges that have BRP recordings. Only these have waveforms to show. */
  segments: { from: Temporal.Instant; to: Temporal.Instant }[];
  events: WaveformEvent[];
};
