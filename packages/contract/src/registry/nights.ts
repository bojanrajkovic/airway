import { AHI_CHECKS } from "../derived/values.ts";
import { RULE_SETS } from "../profile.ts";
import { count, minutes, night } from "./columns.ts";
import {
  dimension,
  enumeration,
  metric,
  signal,
  time,
  type Combine,
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
  max: "Highest",
} as const;
type Statistic = keyof typeof STATISTICS;

const combined = (column: MetricColumn, combine: Combine): NightsMetric => ({
  ...column,
  combine,
});

/**
 * The machine's nightly statistics of one signal: `leak_p50`, `leak_p95`, and so on. A week's
 * percentile is the median of its nights' values, and its maximum is the highest night's.
 */
function machineStatistics(
  name: string,
  what: string,
  statistics: readonly Statistic[] = ["p50", "p95", "max"],
): NightsMetric[] {
  return statistics.map((statistic) =>
    combined(
      signal(`${name}_${statistic}`, `${STATISTICS[statistic]} ${what} over the night.`),
      statistic === "max" ? "max" : "median",
    ),
  );
}

const perHour = (name: string, what: string): NightsMetric =>
  combined(signal(name, `${what} per hour of use, as the machine scored it.`), "rate");
// Durations and counts read as "per night", so a week reads on the same scale as one night.
const perNight = (column: MetricColumn): NightsMetric => combined(column, "mean");
const eventCount = (name: string, what: string): NightsMetric =>
  perNight(metric(name, count("events"), `${what} the machine flagged.`));

/** A nights column. A metric without its `combine` doesn't compile. */
export type NightsColumn = TimeColumn | DimensionColumn | NightsMetric;

export const nights: Omit<Dataset, "columns"> & {
  columns: readonly [NightsColumn, ...NightsColumn[]];
} = {
  name: "nights",
  description:
    "One row per night. The machine's own statistics come first, then the numbers airway derives.",
  grain: "night",
  columns: [
    night,

    // The machine's, from STR.edf.
    perNight(signal("usage", "Time with the mask on.")),
    perNight(signal("machine_on", "Time the machine was running.")),
    perNight(signal("mask_events", "Times the mask went on or came off.")),
    perHour("ahi", "Apneas and hypopneas"),
    perHour("hi", "Hypopneas"),
    perHour("ai", "Apneas of every kind"),
    perHour("oai", "Obstructive apneas"),
    perHour("cai", "Central apneas"),
    perHour("uai", "Apneas the machine couldn't classify"),
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

    // airway's.
    perNight(metric("sessions", count("sessions"), "Mask-on periods.")),
    perNight(
      metric(
        "expected_sessions",
        count("sessions"),
        "Mask-on periods the machine counted: half its mask events.",
      ),
    ),
    dimension(
      "session_count_approximate",
      "boolean",
      "True when airway's mask-on periods can't add up to the machine's count.",
    ),
    perNight(metric("longest_stretch", minutes, "The longest unbroken mask-on period.")),
    eventCount("obstructive_apneas", "Obstructive apneas"),
    eventCount("central_apneas", "Central apneas"),
    eventCount("unclassified_apneas", "Apneas of no known kind"),
    eventCount("hypopneas", "Hypopneas"),
    eventCount("arousals", "Arousals"),
    eventCount("events_outside_mask_on", "Events outside every mask-on period"),
    enumeration(
      "ahi_check",
      AHI_CHECKS,
      "Whether the AHI airway recomputes from the events equals the machine's.",
    ),
    enumeration("rule_set", RULE_SETS, "The scoring rules for the patient's age on this night."),
    time("uploaded_at", "timestamp", "When the night's files finished arriving."),
  ],
};
