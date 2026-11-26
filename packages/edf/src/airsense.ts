import type { EVENT_TYPES } from "@airway/contract/derived/values";
import { decimalsForStep, type ColumnUnit } from "@airway/contract/registry/units";
import type { EdfHeader, SignalHeader } from "./header.ts";

/**
 * Names where ingest writes a signal's values: a column of the `samples` or `nights` dataset,
 * or a named setting in `settings_changes`. Ingest skips a signal whose target table is `none`.
 */
export type SignalTarget =
  | { table: "samples"; column: string }
  | { table: "nights"; column: string }
  | { table: "settings"; name: string }
  | { table: "none" };

/**
 * Describes one signal of an AirSense 10 file type and names where ingest writes the signal's
 * values.
 */
export type EdfSignal<L extends string = string> = SignalHeader<L> & { target: SignalTarget };

/**
 * Describes one kind of file that an AirSense 10 writes: its EDF format, record length, and
 * signals.
 */
export type EdfFileType<L extends string = string> = Pick<EdfHeader, "recordSeconds"> & {
  /** Signal files use `EDF`, and annotation files use `EDF+D`. */
  format: Exclude<EdfHeader["format"], "EDF+C">;
  /**
   * Lists the signals in header order. Every file ends with `Crc16`. Annotation files declare a
   * record length of 0 seconds.
   */
  signals: readonly EdfSignal<L>[];
};

/** Resolves to the union of a file type's signal labels. */
export type LabelOf<F extends EdfFileType> = F["signals"][number]["label"];
/** Resolves to the union of a file type's signal labels, excluding the trailing Crc16. */
export type DataLabel<F extends EdfFileType> = Exclude<LabelOf<F>, "Crc16">;

/** Returns the size of one digital step in physical units, such as 0.02 cmH2O for pressure. */
export function step(signal: SignalHeader): number {
  return (
    (Number(signal.physicalMax) - Number(signal.physicalMin)) /
    (signal.digitalMax - signal.digitalMin)
  );
}

/** Returns a file's signals except the trailing Crc16, which is a checksum. */
export const dataSignals = <F extends EdfFileType>(file: F): readonly EdfSignal<DataLabel<F>>[] =>
  file.signals.filter((signal): signal is EdfSignal<DataLabel<F>> => signal.label !== "Crc16");

const none: SignalTarget = { table: "none" };
const sample = (column: string): SignalTarget => ({ table: "samples", column });
const night = (column: string): SignalTarget => ({ table: "nights", column });

/** Lists a signal's unit, physical range, and digital range in header order. */
type Measure = readonly [
  unit: string,
  physicalMin: string,
  physicalMax: string,
  digitalMin: number,
  digitalMax: number,
];

function signal<const L extends string>(
  label: L,
  [unit, physicalMin, physicalMax, digitalMin, digitalMax]: Measure,
  samplesPerRecord: number,
  target: SignalTarget = none,
): EdfSignal<L> {
  return {
    label,
    unit,
    physicalMin,
    physicalMax,
    digitalMin,
    digitalMax,
    samplesPerRecord,
    target,
  };
}

const crc16 = signal("Crc16", ["", "-32768", "32767", -32768, 32767], 1);

// These settings have their own names in `settings_changes`. Every other S.* setting uses its
// label as its name.
const SETTING_NAMES: Readonly<Record<string, string>> = {
  "S.AS.MinPress": "min_pressure",
  "S.AS.MaxPress": "max_pressure",
  "S.EPR.Level": "epr_level",
  "S.RampTime": "ramp_time",
};

const setting = <const L extends string>(label: L, measure: Measure): EdfSignal<L> =>
  signal(label, measure, 1, { table: "settings", name: SETTING_NAMES[label] ?? label });

// The machine stores an on/off value or a choice as a code from 0 to 16.
const CODE: Measure = ["", "0", "16", 0, 16];
const choice = <const L extends string>(label: L): EdfSignal<L> => setting(label, CODE);
const flag = <const L extends string>(label: L): EdfSignal<L> => signal(label, CODE, 1);
const pressureSetting = <const L extends string>(label: L): EdfSignal<L> =>
  setting(label, ["cmH2O", "4.00", "20.00", 200, 1000]);

const STATISTIC_SUFFIXES = { "50": "p50", "70": "p70", "95": "p95", Max: "max" } as const;
type StatisticSuffix = keyof typeof STATISTIC_SUFFIXES;
// Most STR statistics are a median, a 95th percentile, and a maximum.
const TYPICAL = ["50", "95", "Max"] as const;

// Returns one STR signal for each nightly statistic that the machine computes, such as Leak.50,
// which ingest writes to leak_p50.
function statistics<const P extends string, const S extends StatisticSuffix>(
  prefix: P,
  column: string,
  measure: Measure,
  suffixes: readonly S[],
): EdfSignal<`${P}.${S}`>[] {
  return suffixes.map((suffix) =>
    signal(`${prefix}.${suffix}`, measure, 1, night(`${column}_${STATISTIC_SUFFIXES[suffix]}`)),
  );
}

const index = <const L extends string>(label: L): EdfSignal<L> =>
  signal(label, ["", "0.00", "240.00", 0, 2400], 1, night(label.toLowerCase()));

const flow = signal("Flow.40ms", ["L/s", "-2.00", "3.00", -1000, 1500], 1500);

/** BRP files store flow and pressure at 25 Hz, in 60 s records. */
const brp = {
  format: "EDF",
  recordSeconds: 60,
  signals: [flow, signal("Press.40ms", ["cmH2O", "0.00", "40.00", 0, 2000], 1500), crc16],
} satisfies EdfFileType;

/** PLD files store one value every 2 s for each signal, in 60 s records. */
const pld = {
  format: "EDF",
  recordSeconds: 60,
  signals: [
    signal("MaskPress.2s", ["cmH2O", "0.00", "40.00", 0, 2000], 30, sample("mask_pressure")),
    signal("Press.2s", ["cmH2O", "0.00", "30.00", 0, 1500], 30, sample("pressure")),
    signal("EprPress.2s", ["cmH2O", "0.00", "30.00", 0, 1500], 30, sample("epr_pressure")),
    signal("Leak.2s", ["L/s", "0.00", "2.00", 0, 100], 30, sample("leak")),
    signal("RespRate.2s", ["bpm", "0.00", "50.00", 0, 250], 30, sample("respiratory_rate")),
    signal("TidVol.2s", ["L", "0.00", "4.00", 0, 200], 30, sample("tidal_volume")),
    signal("MinVent.2s", ["L/min", "0.00", "30.00", 0, 240], 30, sample("minute_ventilation")),
    signal("Snore.2s", ["", "0.00", "5.00", 0, 250], 30, sample("snore")),
    signal("FlowLim.2s", ["", "0.00", "1.00", 0, 100], 30, sample("flow_limitation")),
    crc16,
  ],
} satisfies EdfFileType;

/**
 * SAD files store pulse oximetry at 1 Hz, in 60 s records. Without a sensor, every value is
 * missing.
 */
const sad = {
  format: "EDF",
  recordSeconds: 60,
  signals: [
    signal("Pulse.1s", ["bpm", "18.00", "300.00", 18, 300], 60),
    signal("SpO2.1s", ["%", "0.00", "100.00", 0, 100], 60),
    crc16,
  ],
} satisfies EdfFileType;

const annotations = (samplesPerRecord: number): EdfFileType<"EDF Annotations" | "Crc16"> => ({
  format: "EDF+D",
  recordSeconds: 0,
  signals: [
    signal("EDF Annotations", ["", "0.00", "86400.00", -32768, 32767], samplesPerRecord),
    crc16,
  ],
});

/** EVE files store the machine's events, with one annotation per record. */
const eve = annotations(19);
/**
 * CSL files store Cheyne-Stokes periods. A CSL file from a night without Cheyne-Stokes breathing
 * contains only the "Recording starts" annotation.
 */
const csl = annotations(15);

/** STR.edf is the daily summary, with one 86,400 s record per day. */
const str = {
  format: "EDF",
  recordSeconds: 86_400,
  signals: [
    signal("Date", ["", "0.00", "24836.00", 0, 24836], 1),
    signal("MaskOn", ["min.", "0.00", "1440.00", 0, 1440], 10),
    signal("MaskOff", ["min.", "0.00", "1440.00", 0, 1440], 10),
    signal("MaskEvents", ["", "0.00", "255.00", 0, 255], 1, night("mask_events")),
    signal("Duration", ["min.", "0.00", "1440.00", 0, 1440], 1, night("machine_on")),
    signal("OnDuration", ["min.", "0.00", "1440.00", 0, 1440], 1, night("usage")),
    signal("PatientHours", ["hrs", "0.00", "65534.00", 0, 65534], 1),
    flag("Mode"),
    choice("S.RampEnable"),
    setting("S.RampTime", ["min.", "5.00", "45.00", 5, 45]),
    pressureSetting("S.C.StartPress"),
    pressureSetting("S.C.Press"),
    choice("S.EPR.ClinEnable"),
    choice("S.EPR.EPREnable"),
    setting("S.EPR.Level", ["cmH2O", "1.00", "3.00", 50, 150]),
    choice("S.EPR.EPRType"),
    choice("S.AS.Comfort"),
    pressureSetting("S.AS.StartPress"),
    pressureSetting("S.AS.MaxPress"),
    pressureSetting("S.AS.MinPress"),
    choice("S.SmartStart"),
    choice("S.PtAccess"),
    choice("S.ABFilter"),
    choice("S.Mask"),
    choice("S.Tube"),
    choice("S.ClimateControl"),
    choice("S.HumEnable"),
    setting("S.HumLevel", ["", "1.00", "8.00", 1, 8]),
    choice("S.TempEnable"),
    setting("S.Temp", ["°C", "16.00", "30.00", 160, 300]),
    flag("HeatedTube"),
    flag("Humidifier"),
    signal("BlowPress.95", ["cmH2O", "0.00", "45.00", 0, 2250], 1),
    signal("BlowPress.5", ["cmH2O", "0.00", "45.00", 0, 2250], 1),
    signal("Flow.95", ["L/s", "0.00", "3.00", 0, 1500], 1),
    signal("Flow.5", ["L/s", "0.00", "3.00", 0, 1500], 1),
    signal("BlowFlow.50", ["L/min", "0.00", "250.00", 0, 25000], 1),
    signal("AmbHumidity.50", ["mg/L", "0.00", "100.00", 0, 100], 1, night("ambient_humidity_p50")),
    signal("HumTemp.50", ["°C", "0.00", "95.00", 0, 950], 1, night("humidifier_temperature_p50")),
    signal("HTubeTemp.50", ["°C", "0.00", "40.00", 0, 400], 1, night("tube_temperature_p50")),
    signal("HTubePow.50", ["", "0.00", "100.00", 0, 100], 1, night("tube_power_p50")),
    signal("HumPow.50", ["", "0.00", "100.00", 0, 100], 1, night("humidifier_power_p50")),
    signal("SpO2.50", ["%", "0.00", "100.00", 0, 100], 1),
    signal("SpO2.95", ["%", "0.00", "100.00", 0, 100], 1),
    signal("SpO2.Max", ["%", "0.00", "100.00", 0, 100], 1),
    signal("SpO2Thresh", ["min.", "0.00", "1440.00", 0, 1440], 1),
    ...statistics("MaskPress", "mask_pressure", ["cmH2O", "0.00", "30.00", 0, 1500], TYPICAL),
    ...statistics("TgtIPAP", "target_ipap", ["cmH2O", "0.00", "30.00", 0, 1500], TYPICAL),
    ...statistics("TgtEPAP", "target_epap", ["cmH2O", "0.00", "30.00", 0, 1500], TYPICAL),
    ...statistics("Leak", "leak", ["L/s", "0.00", "2.00", 0, 100], ["50", "95", "70", "Max"]),
    ...statistics("MinVent", "minute_ventilation", ["L/min", "0.00", "30.00", 0, 240], TYPICAL),
    ...statistics("RespRate", "respiratory_rate", ["bpm", "0.00", "50.00", 0, 250], TYPICAL),
    ...statistics("TidVol", "tidal_volume", ["L", "0.00", "4.00", 0, 200], TYPICAL),
    index("AHI"),
    index("HI"),
    index("AI"),
    index("OAI"),
    index("CAI"),
    index("UAI"),
    index("RIN"),
    signal("CSR", ["", "0.00", "1440.00", 0, 1440], 1, night("csr")),
    flag("Fault.Device"),
    flag("Fault.Alarm"),
    flag("Fault.Humidifier"),
    flag("Fault.HeatedTube"),
    crc16,
  ],
} satisfies EdfFileType;

/**
 * Describes every kind of EDF file that airway reads or writes for an AirSense 10, as the file
 * headers declare it. Every AirSense 10 uses the same format.
 */
export const AIRSENSE = { brp, pld, sad, eve, csl, str } as const satisfies Record<
  string,
  EdfFileType
>;

/**
 * A PLD signal has one value every `PLD_SAMPLE_SECONDS` seconds. The samples in a record are evenly
 * spaced over the record's 60 s.
 */
export const PLD_SAMPLE_SECONDS = pld.recordSeconds / (pld.signals[0]?.samplesPerRecord ?? 1);

/** Maps each event type that the machine scores to the label that it writes in EVE files. */
export const EVENT_LABELS: Readonly<
  Record<Exclude<(typeof EVENT_TYPES)[number], "other">, string>
> = {
  obstructive_apnea: "Obstructive Apnea",
  central_apnea: "Central Apnea",
  unclassified_apnea: "Apnea",
  hypopnea: "Hypopnea",
  arousal: "Arousal",
};

/** The unit and decimals of a dataset column that holds a machine signal. */
export type SignalColumnUnit = ColumnUnit & { dataset: string; column_name: string };

// Returns the unit and decimals of each signal in `file` that's stored in the `dataset` table.
const unitRows = (file: EdfFileType, dataset: "nights" | "samples"): SignalColumnUnit[] =>
  dataSignals(file).flatMap((signal) =>
    signal.target.table === dataset
      ? [
          {
            dataset,
            column_name: signal.target.column,
            unit: signal.unit,
            decimals: decimalsForStep(step(signal)),
          },
        ]
      : [],
  );
const flowDecimals = decimalsForStep(step(flow));

/**
 * Lists the unit and decimals of each column that stores a machine signal.
 * docs/data-model.md#units explains the decimals.
 */
export const COLUMN_UNITS: readonly SignalColumnUnit[] = [
  ...unitRows(str, "nights"),
  ...unitRows(pld, "samples"),
  { dataset: "breaths", column_name: "amplitude", unit: flow.unit, decimals: flowDecimals },
  { dataset: "breaths", column_name: "inspiratory_volume", unit: "L", decimals: flowDecimals },
];
