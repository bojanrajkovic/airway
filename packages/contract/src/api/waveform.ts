import { z } from "zod";
import { Instant, PlainDate } from "../dates.ts";
import type { EVENT_TYPES } from "../derived/values.ts";

/**
 * The most buckets that one `waveform.window` request can ask for. The viewer asks for one bucket
 * per pixel of the plot's width.
 */
export const MAX_WAVEFORM_BUCKETS = 4000;

/**
 * `waveform.window` takes a stretch of one night and the number of buckets to split that stretch
 * into. The viewer sets `buckets` to the plot's width in pixels.
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

/** `waveform.night` takes the night to show. */
export const WaveformNight = z.strictObject({ night: PlainDate });
export type WaveformNight = z.infer<typeof WaveformNight>;

/** The signals that the waveform viewer plots. */
export const WAVEFORM_SIGNALS = ["flow", "pressure", "leak", "flow_limitation"] as const;
export type WaveformSignal = (typeof WAVEFORM_SIGNALS)[number];

/**
 * One signal's values from one recording file. Values are evenly spaced from `start`, `step`
 * milliseconds apart. When a bucket contains more than two samples, the piece lists each bucket's
 * lowest value in `min` and highest value in `max`. Otherwise the piece lists the raw samples in
 * `values`.
 */
export type WaveformPiece = { start: Temporal.Instant; step: number } & (
  | { kind: "range"; min: number[]; max: number[] }
  | { kind: "samples"; values: number[] }
);

/** One signal's values in its stored unit, with one piece per recording file. */
export type WaveformSeries = { unit: string; pieces: WaveformPiece[] };

type EventType = (typeof EVENT_TYPES)[number];
/**
 * An event that the machine flagged. `duration` is in seconds, and it's null for an event that
 * lacks a duration.
 */
export type WaveformEvent = { ts: Temporal.Instant; type: EventType; duration: number | null };

/** `waveform.window` returns each signal's values over the window, keyed by signal name. */
export type WaveformData = {
  signals: Record<WaveformSignal, WaveformSeries>;
  /** The events that overlap the window. */
  events: WaveformEvent[];
};

/**
 * `waveform.night` returns a whole night's sessions, recorded time ranges, and events. The viewer
 * shows them in a strip above the signal plots.
 */
export type WaveformOverview = {
  night: Temporal.PlainDate;
  sessions: { from: Temporal.Instant; to: Temporal.Instant }[];
  /** BRP files cover these time ranges. The viewer can show waveforms only inside these ranges. */
  segments: { from: Temporal.Instant; to: Temporal.Instant }[];
  events: WaveformEvent[];
};
