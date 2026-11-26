import { valuesOf } from "../enum.ts";
import { AhiOutcome } from "../derived/values.ts";
import { RuleSet } from "../profile.ts";
import { count, minutes, night } from "./columns.ts";
import {
  Combine,
  dimension,
  enumeration,
  Granularity,
  metric,
  signal,
  time,
  type Dataset,
  type DimensionColumn,
  type MetricColumn,
  type NightsMetric,
  type TimeColumn,
} from "./define.ts";

const STATISTICS = {
  p50: "Median",
  p70: "70th percentile of",
  p95: "95th percentile of",
  max: "Maximum",
} as const;
type Statistic = keyof typeof STATISTICS;

const combined = (column: MetricColumn, combine: Combine): NightsMetric => ({
  ...column,
  combine,
});

/**
 * Builds the columns for the machine's nightly statistics of one signal, such as `leak_p50` and
 * `leak_p95`. For a week, each percentile is the median of the nightly values, and the maximum
 * is the highest nightly value.
 */
function machineStatistics(
  name: string,
  what: string,
  statistics: readonly Statistic[] = ["p50", "p95", "max"],
): NightsMetric[] {
  return statistics.map((statistic) =>
    combined(
      signal(`${name}_${statistic}`, `${STATISTICS[statistic]} ${what} over the night.`),
      statistic === "max" ? Combine.Max : Combine.Median,
    ),
  );
}

const perHour = (name: string, what: string): NightsMetric =>
  combined(signal(name, `${what} per hour of use, as the machine scored them.`), Combine.Rate);
// airway averages durations and counts over a week's nights, so the week's value is on the same
// scale as one night's value.
const perNight = (column: MetricColumn): NightsMetric => combined(column, Combine.Mean);
const eventCount = (name: string, what: string): NightsMetric =>
  perNight(metric(name, count("events"), `${what} that the machine flagged.`));

export type NightsColumn = TimeColumn | DimensionColumn | NightsMetric;

export const nights: Omit<Dataset, "columns"> & {
  columns: readonly [NightsColumn, ...NightsColumn[]];
} = {
  name: "nights",
  description:
    "Each row is one night. The machine's statistics come first, then airway's derived numbers.",
  grain: Granularity.Night,
  columns: [
    night,

    // These columns come from the machine's statistics in STR.edf.
    perNight(signal("usage", "Time with the mask on.")),
    perNight(signal("machine_on", "Time the machine was running.")),
    perNight(signal("mask_events", "How many times the mask went on or came off.")),
    perHour("ahi", "Apneas and hypopneas"),
    perHour("hi", "Hypopneas"),
    perHour("ai", "Apneas of every kind"),
    perHour("oai", "Obstructive apneas"),
    perHour("cai", "Central apneas"),
    perHour("uai", "Unclassified apneas"),
    perHour("rin", "Arousals from breathing effort"),
    perNight(signal("csr", "Time in Cheyne-Stokes breathing.")),
    ...machineStatistics("mask_pressure", "pressure at the mask"),
    ...machineStatistics("target_ipap", "target pressure on the in-breath"),
    ...machineStatistics("target_epap", "target pressure on the out-breath"),
    ...machineStatistics("leak", "unintentional leak", ["p50", "p70", "p95", "max"]),
    ...machineStatistics("minute_ventilation", "air moved per minute"),
    ...machineStatistics("respiratory_rate", "breaths per minute"),
    ...machineStatistics("tidal_volume", "air moved by one breath"),
    ...machineStatistics("ambient_humidity", "humidity of the room air", ["p50"]),
    ...machineStatistics("humidifier_temperature", "humidifier plate temperature", ["p50"]),
    ...machineStatistics("tube_temperature", "heated tube temperature", ["p50"]),
    ...machineStatistics("humidifier_power", "humidifier heater power", ["p50"]),
    ...machineStatistics("tube_power", "heated tube power", ["p50"]),

    // airway derives these columns.
    perNight(metric("sessions", count("sessions"), "Mask-on periods.")),
    perNight(
      metric(
        "expected_sessions",
        count("sessions"),
        "The machine's count of mask-on periods, which is half the number of mask events.",
      ),
    ),
    dimension(
      "session_count_approximate",
      "boolean",
      "True when airway's count of mask-on periods differs from the machine's count.",
    ),
    perNight(metric("longest_stretch", minutes, "The longest unbroken mask-on period.")),
    eventCount("obstructive_apneas", "Obstructive apneas"),
    eventCount("central_apneas", "Central apneas"),
    eventCount("unclassified_apneas", "Unclassified apneas"),
    eventCount("hypopneas", "Hypopneas"),
    eventCount("arousals", "Arousals"),
    eventCount("events_outside_mask_on", "Events outside every mask-on period"),
    enumeration(
      "ahi_check",
      valuesOf(AhiOutcome),
      "Whether the AHI that airway recomputes from the events equals the machine's AHI.",
    ),
    enumeration(
      "rule_set",
      valuesOf(RuleSet),
      "The scoring rules for the patient's age on this night.",
    ),
    time("arrived_at", "timestamp", "When the night's files finished arriving."),
  ],
};
