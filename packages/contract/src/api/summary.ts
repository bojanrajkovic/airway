import { z } from "zod";
import { PlainDate } from "../dates.ts";
import type { PERCENTILE_SIGNALS } from "../derived/values.ts";
import type { LastNightStatus } from "./last-night.ts";

/**
 * How nights are grouped: one per night, ISO weeks starting Monday, or calendar months. The trends
 * page's toggle, its links, and `summarize_nights` all use these values; the toggle labels `night`
 * as "Day".
 */
export const SUMMARY_STEPS = ["night", "week", "month"] as const;
export type SummaryStep = (typeof SUMMARY_STEPS)[number];

const range = { from: PlainDate, to: PlainDate };
const inOrder = ({ from, to }: { from: Temporal.PlainDate; to: Temporal.PlainDate }): boolean =>
  Temporal.PlainDate.compare(from, to) <= 0;
const IN_ORDER = { error: "`from` must not be after `to`" };

/** A night range, first night to last, both included. `summary.settingsChanges` takes one. */
export const NightRange = z.strictObject(range).refine(inOrder, IN_ORDER);
export type NightRange = z.infer<typeof NightRange>;

/** What `summary.range` and `summarize_nights` take. */
export const SummaryRange = z
  .strictObject({ ...range, step: z.enum(SUMMARY_STEPS) })
  .refine(inOrder, IN_ORDER);
export type SummaryRange = z.infer<typeof SummaryRange>;

/**
 * Each nights metric's value, keyed by column name. A bucket with no used nights has nulls, never
 * zeros. How a week or month combines each one is its column's `combine` in the registry.
 */
export type MetricValues = Record<string, number | null>;

type PercentileSignal = (typeof PERCENTILE_SIGNALS)[number];
/** A signal's percentiles over a week or month, recomputed from its 2 s samples. */
export type SamplePercentiles = Record<
  PercentileSignal,
  { p50: number | null; p95: number | null }
>;

/** One step of a summary: a night, a week, or a month. */
export type SummaryBucket = {
  /** The bucket's first night: the night itself, a Monday, or the 1st of a month. */
  start: Temporal.PlainDate;
  /** Nights in the bucket that fall in the range. */
  nights: number;
  /** How many of those nights STR.edf shows any use on. Only these are combined. */
  usedNights: number;
  values: MetricValues;
  /** Set on week and month buckets only. The day view shows only the machine's values. */
  samplePercentiles: SamplePercentiles | null;
};

/** What `summary.range` returns: a bucket for every step in the range, empty ones included. */
export type RangeSummary = SummaryRange & {
  buckets: SummaryBucket[];
  /** An absolute link to the trends page for the same range and step. */
  link: string;
};

/**
 * What `summary.lastNight` returns. Only an arrived night has numbers; for the others, the card
 * says why there are none.
 */
export type LastNightSummary =
  | {
      night: Temporal.PlainDate;
      status: "arrived";
      /** When the night's files finished arriving. */
      uploadedAt: Temporal.Instant;
      values: MetricValues;
    }
  | { night: Temporal.PlainDate; status: Exclude<LastNightStatus, "arrived"> };

/** One machine setting that changed on a night, in the device's units, as STR.edf records it. */
export type SettingChange = {
  night: Temporal.PlainDate;
  /** The setting's name as ingest spells it. */
  setting: string;
  oldValue: number | null;
  newValue: number | null;
};
