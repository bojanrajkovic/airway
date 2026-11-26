import { z } from "zod";
import { PlainDate } from "../dates.ts";
import type { PercentileSignal } from "../derived/values.ts";
import type { LastNightStatus } from "./last-night.ts";

/**
 * Lists the steps that a summary can bucket nights by. A `week` is an ISO week, which starts on
 * Monday.
 */
export enum SummaryStep {
  Night = "night",
  Week = "week",
  Month = "month",
}

const range = { from: PlainDate, to: PlainDate };
const inOrder = ({ from, to }: { from: Temporal.PlainDate; to: Temporal.PlainDate }): boolean =>
  Temporal.PlainDate.compare(from, to) <= 0;
const IN_ORDER = { error: "`from` must be on or before `to`" };

/**
 * Validates the range of nights that `summary.settingsChanges` takes. The range includes both
 * `from` and `to`.
 */
export const NightRange = z.strictObject(range).refine(inOrder, IN_ORDER);
export type NightRange = z.infer<typeof NightRange>;

/** Validates the input of `summary.range` and `summarize_nights`. */
export const SummaryRange = z
  .strictObject({ ...range, step: z.enum(SummaryStep) })
  .refine(inOrder, IN_ORDER);
export type SummaryRange = z.infer<typeof SummaryRange>;

/** Maps each `nights` metric's column name to the metric's value. */
export type MetricValues = Record<string, number | null>;

/**
 * Maps each percentile signal to its P50 and P95 over a week or month, recomputed from the
 * signal's 2 s samples.
 */
export type SamplePercentiles = Record<
  PercentileSignal,
  { p50: number | null; p95: number | null }
>;

/** Describes one step of a summary, which covers a night, a week, or a month. */
export type SummaryBucket = {
  /**
   * `start` is the bucket's first night. For a week that's a Monday, and for a month it's the
   * 1st.
   */
  start: Temporal.PlainDate;
  /** `nights` counts the bucket's nights that fall in the range. */
  nights: number;
  /**
   * `usedNights` counts the nights in the range that have any use recorded in STR.edf. Summaries
   * combine only these nights.
   */
  usedNights: number;
  values: MetricValues;
  /**
   * `samplePercentiles` is null on a `night` bucket, whose `values` contain the machine's
   * percentiles.
   */
  samplePercentiles: SamplePercentiles | null;
};

/** `summary.range` returns a bucket for every step in the range, including the empty buckets. */
export type RangeSummary = SummaryRange & {
  buckets: SummaryBucket[];
  /** Opens the trends page for the same range and step. The link is absolute. */
  link: string;
};

/** `summary.lastNight` returns last night's status. An `arrived` night also includes its values. */
export type LastNightSummary =
  | {
      night: Temporal.PlainDate;
      status: "arrived";
      /** `arrivedAt` is when the night's files finished arriving. */
      arrivedAt: Temporal.Instant;
      values: MetricValues;
    }
  | { night: Temporal.PlainDate; status: Exclude<LastNightStatus, "arrived"> };

/**
 * Describes one machine setting that changed on a night. The values are in the device's units, as
 * STR.edf records them.
 */
export type SettingChange = {
  night: Temporal.PlainDate;
  /** `setting` is the setting's name as ingest spells it. */
  setting: string;
  oldValue: number | null;
  newValue: number | null;
};
