import { z } from "zod";
import { PlainDate } from "../dates.ts";
import type { PERCENTILE_SIGNALS } from "../derived/values.ts";
import type { LastNightStatus } from "./last-night.ts";

/** The steps that a summary buckets nights by. A `week` is an ISO week, which starts on Monday. */
export const SUMMARY_STEPS = ["night", "week", "month"] as const;
export type SummaryStep = (typeof SUMMARY_STEPS)[number];

const range = { from: PlainDate, to: PlainDate };
const inOrder = ({ from, to }: { from: Temporal.PlainDate; to: Temporal.PlainDate }): boolean =>
  Temporal.PlainDate.compare(from, to) <= 0;
const IN_ORDER = { error: "`from` must be on or before `to`" };

/** The range of nights that `summary.settingsChanges` takes. It includes both `from` and `to`. */
export const NightRange = z.strictObject(range).refine(inOrder, IN_ORDER);
export type NightRange = z.infer<typeof NightRange>;

/** What `summary.range` and `summarize_nights` take. */
export const SummaryRange = z
  .strictObject({ ...range, step: z.enum(SUMMARY_STEPS) })
  .refine(inOrder, IN_ORDER);
export type SummaryRange = z.infer<typeof SummaryRange>;

/** Maps each `nights` metric's column name to the metric's value. */
export type MetricValues = Record<string, number | null>;

type PercentileSignal = (typeof PERCENTILE_SIGNALS)[number];
/** A signal's percentiles over a week or month, recomputed from its 2 s samples. */
export type SamplePercentiles = Record<
  PercentileSignal,
  { p50: number | null; p95: number | null }
>;

/** One step of a summary, which covers a night, a week, or a month. */
export type SummaryBucket = {
  /** The bucket's first night. For a week that's a Monday, and for a month it's the 1st. */
  start: Temporal.PlainDate;
  /** How many of the bucket's nights fall in the range. */
  nights: number;
  /** How many of those nights have any use recorded in STR.edf. Summaries combine only these. */
  usedNights: number;
  values: MetricValues;
  /** Null on a `night` bucket, whose `values` contain the machine's percentiles. */
  samplePercentiles: SamplePercentiles | null;
};

/** `summary.range` returns a bucket for every step in the range, including the empty buckets. */
export type RangeSummary = SummaryRange & {
  buckets: SummaryBucket[];
  /** An absolute link to the trends page for the same range and step. */
  link: string;
};

/** `summary.lastNight` returns last night's status. An `arrived` night also includes its values. */
export type LastNightSummary =
  | {
      night: Temporal.PlainDate;
      status: "arrived";
      /** When the night's files finished arriving. */
      arrivedAt: Temporal.Instant;
      values: MetricValues;
    }
  | { night: Temporal.PlainDate; status: Exclude<LastNightStatus, "arrived"> };

/**
 * One machine setting that changed on a night. The values are in the device's units, as STR.edf
 * records them.
 */
export type SettingChange = {
  night: Temporal.PlainDate;
  /** The setting's name as ingest spells it. */
  setting: string;
  oldValue: number | null;
  newValue: number | null;
};
