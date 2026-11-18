import type { EdfHeader, SignalHeader } from "./header.ts";

/**
 * Where a signal's values go when ingest reads them: a column of the `samples` or `nights`
 * dataset, a named setting in `settings_changes`, or nowhere.
 */
export type SignalTarget =
  | { table: "samples"; column: string }
  | { table: "nights"; column: string }
  | { table: "settings"; name: string }
  | { table: "none" };

/** One signal of an AirSense 10 file type, and where ingest puts its values. */
export type EdfSignal = SignalHeader & { target: SignalTarget };

/** One AirSense 10 file type. */
export type EdfFileType = Pick<EdfHeader, "recordSeconds"> & {
  /** `EDF` for signal files, `EDF+D` for annotation files. */
  format: Exclude<EdfHeader["format"], "EDF+C">;
  /** In header order. Every file ends with `Crc16`. Annotation files use 0 record seconds. */
  signals: readonly EdfSignal[];
};

/** One digital step in physical units, such as 0.02 cmH2O for pressure. */
export function step(signal: SignalHeader): number {
  return (
    (Number(signal.physicalMax) - Number(signal.physicalMin)) /
    (signal.digitalMax - signal.digitalMin)
  );
}

/** A file's signals without its trailing Crc16, which holds a checksum rather than data. */
export const dataSignals = (file: EdfFileType): readonly EdfSignal[] =>
  file.signals.filter((signal) => signal.label !== "Crc16");

const none: SignalTarget = { table: "none" };
const sample = (column: string): SignalTarget => ({ table: "samples", column });
const night = (column: string): SignalTarget => ({ table: "nights", column });

/** A signal's unit, physical range, and digital range, in header order. */
type Measure = readonly [
  unit: string,
  physicalMin: string,
  physicalMax: string,
  digitalMin: number,
  digitalMax: number,
];

function signal(
  label: string,
  [unit, physicalMin, physicalMax, digitalMin, digitalMax]: Measure,
  samplesPerRecord: number,
  target: SignalTarget = none,
): EdfSignal {
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

// Settings #12 names. Every other S.* setting keeps its label as its name.
const SETTING_NAMES: Readonly<Record<string, string>> = {
  "S.AS.MinPress": "min_pressure",
  "S.AS.MaxPress": "max_pressure",
  "S.EPR.Level": "epr_level",
  "S.RampTime": "ramp_time",
};

const setting = (label: string, measure: Measure): EdfSignal =>
  signal(label, measure, 1, { table: "settings", name: SETTING_NAMES[label] ?? label });

// An on/off or choice code, stored as 0 to 16.
const CODE: Measure = ["", "0", "16", 0, 16];
const choice = (label: string): EdfSignal => setting(label, CODE);
const flag = (label: string): EdfSignal => signal(label, CODE, 1);
const pressureSetting = (label: string): EdfSignal =>
  setting(label, ["cmH2O", "4.00", "20.00", 200, 1000]);

const STATISTIC_SUFFIXES = { "50": "p50", "70": "p70", "95": "p95", Max: "max" } as const;
type StatisticSuffix = keyof typeof STATISTIC_SUFFIXES;

// The machine's nightly statistics of one signal, such as Leak.50 → leak_p50.
function statistics(
  prefix: string,
  column: string,
  measure: Measure,
  suffixes: readonly StatisticSuffix[] = ["50", "95", "Max"],
): EdfSignal[] {
  return suffixes.map((suffix) =>
    signal(`${prefix}.${suffix}`, measure, 1, night(`${column}_${STATISTIC_SUFFIXES[suffix]}`)),
  );
}

const index = (label: string): EdfSignal =>
  signal(label, ["", "0.00", "240.00", 0, 2400], 1, night(label.toLowerCase()));

/** 25 Hz flow and pressure, in 60 s records. */
const brp: EdfFileType = {
  format: "EDF",
  recordSeconds: 60,
  signals: [
    signal("Flow.40ms", ["L/s", "-2.00", "3.00", -1000, 1500], 1500),
    signal("Press.40ms", ["cmH2O", "0.00", "40.00", 0, 2000], 1500),
    crc16,
  ],
};

/** The 2 s signals, in 60 s records. */
const pld: EdfFileType = {
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
};

/** Pulse oximetry, at 1 Hz in 60 s records. Without a sensor, every value is missing. */
const sad: EdfFileType = {
  format: "EDF",
  recordSeconds: 60,
  signals: [
    signal("Pulse.1s", ["bpm", "18.00", "300.00", 18, 300], 60),
    signal("SpO2.1s", ["%", "0.00", "100.00", 0, 100], 60),
    crc16,
  ],
};

const annotations = (samplesPerRecord: number): EdfFileType => ({
  format: "EDF+D",
  recordSeconds: 0,
  signals: [
    signal("EDF Annotations", ["", "0.00", "86400.00", -32768, 32767], samplesPerRecord),
    crc16,
  ],
});

/** The machine's events, one annotation per record. */
const eve = annotations(19);
/** Cheyne-Stokes periods. Without any, it holds only the "Recording starts" annotation. */
const csl = annotations(15);

/** The daily summary: one 86,400 s record per day. */
const str: EdfFileType = {
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
    ...statistics("MaskPress", "mask_pressure", ["cmH2O", "0.00", "30.00", 0, 1500]),
    ...statistics("TgtIPAP", "target_ipap", ["cmH2O", "0.00", "30.00", 0, 1500]),
    ...statistics("TgtEPAP", "target_epap", ["cmH2O", "0.00", "30.00", 0, 1500]),
    ...statistics("Leak", "leak", ["L/s", "0.00", "2.00", 0, 100], ["50", "95", "70", "Max"]),
    ...statistics("MinVent", "minute_ventilation", ["L/min", "0.00", "30.00", 0, 240]),
    ...statistics("RespRate", "respiratory_rate", ["bpm", "0.00", "50.00", 0, 250]),
    ...statistics("TidVol", "tidal_volume", ["L", "0.00", "4.00", 0, 200]),
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
};

/**
 * Every AirSense 10 EDF file airway reads or writes, as its headers declare them. The format
 * details are the same on every AirSense 10.
 */
export const AIRSENSE = { brp, pld, sad, eve, csl, str } as const satisfies Record<
  string,
  EdfFileType
>;

/** Seconds between two values of a PLD signal: each record's samples span its 60 s. */
export const PLD_SAMPLE_SECONDS = pld.recordSeconds / (pld.signals[0]?.samplesPerRecord ?? 1);
