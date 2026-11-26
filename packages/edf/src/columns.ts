import { decimalsForStep, type ColumnUnit } from "@airway/contract/registry/units";
import { AIRSENSE, dataSignals, FLOW, step, type DataLabel, type EdfFileType } from "./airsense.ts";

/**
 * Pairs signal labels of the file type `F` with the names that airway stores their values under.
 * A name is a dataset column or a setting in `settings_changes`. Ingest skips signals that appear
 * in none of these lists.
 */
type LabelColumns<F extends EdfFileType> = readonly (readonly [
  label: DataLabel<F>,
  name: string,
])[];

/** Pairs each PLD signal with its column in the `samples` dataset. */
export const PLD_SAMPLE_COLUMNS = [
  ["MaskPress.2s", "mask_pressure"],
  ["Press.2s", "pressure"],
  ["EprPress.2s", "epr_pressure"],
  ["Leak.2s", "leak"],
  ["RespRate.2s", "respiratory_rate"],
  ["TidVol.2s", "tidal_volume"],
  ["MinVent.2s", "minute_ventilation"],
  ["Snore.2s", "snore"],
  ["FlowLim.2s", "flow_limitation"],
] as const satisfies LabelColumns<typeof AIRSENSE.pld>;

/** Pairs each STR signal that airway stores per night with its column in the `nights` dataset. */
export const STR_NIGHT_COLUMNS = [
  ["MaskEvents", "mask_events"],
  ["Duration", "machine_on"],
  ["OnDuration", "usage"],
  ["AmbHumidity.50", "ambient_humidity_p50"],
  ["HumTemp.50", "humidifier_temperature_p50"],
  ["HTubeTemp.50", "tube_temperature_p50"],
  ["HTubePow.50", "tube_power_p50"],
  ["HumPow.50", "humidifier_power_p50"],
  ["MaskPress.50", "mask_pressure_p50"],
  ["MaskPress.95", "mask_pressure_p95"],
  ["MaskPress.Max", "mask_pressure_max"],
  ["TgtIPAP.50", "target_ipap_p50"],
  ["TgtIPAP.95", "target_ipap_p95"],
  ["TgtIPAP.Max", "target_ipap_max"],
  ["TgtEPAP.50", "target_epap_p50"],
  ["TgtEPAP.95", "target_epap_p95"],
  ["TgtEPAP.Max", "target_epap_max"],
  ["Leak.50", "leak_p50"],
  ["Leak.95", "leak_p95"],
  ["Leak.70", "leak_p70"],
  ["Leak.Max", "leak_max"],
  ["MinVent.50", "minute_ventilation_p50"],
  ["MinVent.95", "minute_ventilation_p95"],
  ["MinVent.Max", "minute_ventilation_max"],
  ["RespRate.50", "respiratory_rate_p50"],
  ["RespRate.95", "respiratory_rate_p95"],
  ["RespRate.Max", "respiratory_rate_max"],
  ["TidVol.50", "tidal_volume_p50"],
  ["TidVol.95", "tidal_volume_p95"],
  ["TidVol.Max", "tidal_volume_max"],
  ["AHI", "ahi"],
  ["HI", "hi"],
  ["AI", "ai"],
  ["OAI", "oai"],
  ["CAI", "cai"],
  ["UAI", "uai"],
  ["RIN", "rin"],
  ["CSR", "csr"],
] as const satisfies LabelColumns<typeof AIRSENSE.str>;

/** Resolves to the labels of STR.edf's settings, which all start with `S.`. */
export type StrSetting = Extract<DataLabel<typeof AIRSENSE.str>, `S.${string}`>;

const isSetting = (label: DataLabel<typeof AIRSENSE.str>): label is StrSetting =>
  label.startsWith("S.");

// These settings have their own names in `settings_changes`. Every other setting uses its label
// as its name.
const SETTING_NAMES: Partial<Record<StrSetting, string>> = {
  "S.AS.MinPress": "min_pressure",
  "S.AS.MaxPress": "max_pressure",
  "S.EPR.Level": "epr_level",
  "S.RampTime": "ramp_time",
};

/** Pairs each STR setting with its name in `settings_changes`. */
export const STR_SETTINGS: readonly (readonly [label: StrSetting, name: string])[] = dataSignals(
  AIRSENSE.str,
).flatMap(({ label }) =>
  isSetting(label) ? [[label, SETTING_NAMES[label] ?? label] as const] : [],
);

/** Extends `ColumnUnit` with the dataset and column that store a machine signal. */
export type SignalColumnUnit = ColumnUnit & { dataset: string; column_name: string };

// Returns the unit and decimals of each column in `columns`, in the order of `file`'s signals.
function unitRows<F extends EdfFileType>(
  file: F,
  dataset: "nights" | "samples",
  columns: LabelColumns<F>,
): SignalColumnUnit[] {
  const names = new Map<string, string>(columns);

  return dataSignals(file).flatMap((signal) => {
    const column_name = names.get(signal.label);

    return column_name === undefined
      ? []
      : [{ dataset, column_name, unit: signal.unit, decimals: decimalsForStep(step(signal)) }];
  });
}

const flowDecimals = decimalsForStep(step(FLOW));

/**
 * Lists the unit and decimals of each column that stores a machine signal.
 * docs/data-model.md#units explains the decimals.
 */
export const COLUMN_UNITS: readonly SignalColumnUnit[] = [
  ...unitRows(AIRSENSE.str, "nights", STR_NIGHT_COLUMNS),
  ...unitRows(AIRSENSE.pld, "samples", PLD_SAMPLE_COLUMNS),
  { dataset: "breaths", column_name: "amplitude", unit: FLOW.unit, decimals: flowDecimals },
  { dataset: "breaths", column_name: "inspiratory_volume", unit: "L", decimals: flowDecimals },
];
