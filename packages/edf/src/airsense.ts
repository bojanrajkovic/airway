import { EventType } from "@airway/contract/derived/values";
import { EdfFormat, type EdfSignalHeader } from "./header.ts";

/**
 * Describes one of the kinds of file that store samples, which are BRP, PLD, SAD, and STR.edf.
 * `header` contains the main-header fields that every file of the kind shares. `signals` lists the
 * signal headers in file order, ending with `Crc16`.
 */
export type EdfSignalFileType<L extends string = string> = {
  header: { format: EdfFormat.Edf; recordSeconds: number };
  signals: readonly EdfSignalHeader<L>[];
};

/**
 * Describes one of the kinds of file that store annotations, which are EVE and CSL. An annotation
 * file is EDF+D and declares a record length of 0 seconds.
 */
export type EdfAnnotationFileType<L extends string = string> = {
  header: { format: EdfFormat.EdfPlusD; recordSeconds: 0 };
  signals: readonly EdfSignalHeader<L>[];
};

/**
 * Describes one kind of file that an AirSense 10 writes, using the header values that every file of
 * that kind declares.
 */
export type EdfFileType<L extends string = string> =
  | EdfSignalFileType<L>
  | EdfAnnotationFileType<L>;

/** Lists the types of file that the AirSense writes in each night's DATALOG folder. */
export enum NightFileType {
  Brp = "brp",
  Pld = "pld",
  Sad = "sad",
  Eve = "eve",
  Csl = "csl",
}

/** Resolves to a night file's type and whether the file is a `.crc` file. */
export type NightFileName = { type: NightFileType; crc: boolean };

const NIGHT_FILE_TYPES: Readonly<Record<string, NightFileType>> = {
  BRP: NightFileType.Brp,
  PLD: NightFileType.Pld,
  SAD: NightFileType.Sad,
  EVE: NightFileType.Eve,
  CSL: NightFileType.Csl,
};
const NIGHT_FILE_NAME = /_(?<type>[A-Z]{3})\.(?<extension>edf|crc)$/v;

/**
 * Reads a night file's type from the end of its name, such as `_BRP.edf` or `_BRP.crc`. Returns
 * undefined when the name doesn't end in `_` plus a known type and `.edf` or `.crc`.
 */
export function nightFileType(name: string): NightFileName | undefined {
  const groups = NIGHT_FILE_NAME.exec(name)?.groups;
  const type = NIGHT_FILE_TYPES[groups?.["type"] ?? ""];

  return type === undefined ? undefined : { type, crc: groups?.["extension"] === "crc" };
}

/** Resolves to the union of a file type's signal labels. */
export type LabelOf<F extends EdfFileType> = F["signals"][number]["label"];
/** Resolves to the union of a file type's signal labels, excluding the trailing Crc16. */
export type DataLabel<F extends EdfFileType> = Exclude<LabelOf<F>, "Crc16">;

/** Returns the size of one digital step in physical units, such as 0.02 cmH2O for pressure. */
export function step(signal: EdfSignalHeader): number {
  return (
    (Number(signal.physicalMax) - Number(signal.physicalMin)) /
    (signal.digitalMax - signal.digitalMin)
  );
}

/** Returns a file's signals except the trailing Crc16, which is a checksum. */
export const dataSignals = <F extends EdfFileType>(
  file: F,
): readonly EdfSignalHeader<DataLabel<F>>[] =>
  file.signals.filter(
    (signal): signal is EdfSignalHeader<DataLabel<F>> => signal.label !== "Crc16",
  );

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
): EdfSignalHeader<L> {
  return { label, unit, physicalMin, physicalMax, digitalMin, digitalMax, samplesPerRecord };
}

const crc16 = signal("Crc16", ["", "-32768", "32767", -32768, 32767], 1);

// The machine stores an on/off value or a choice as a code from 0 to 16.
const code = <const L extends string>(label: L): EdfSignalHeader<L> =>
  signal(label, ["", "0", "16", 0, 16], 1);
const pressureSetting = <const L extends string>(label: L): EdfSignalHeader<L> =>
  signal(label, ["cmH2O", "4.00", "20.00", 200, 1000], 1);

type StatisticSuffix = "50" | "70" | "95" | "Max";
// Most STR statistics are a median, a 95th percentile, and a maximum.
const TYPICAL = ["50", "95", "Max"] as const;

// Returns one STR signal for each nightly statistic that the machine computes, such as Leak.50.
const statistics = <const P extends string, const S extends StatisticSuffix>(
  prefix: P,
  measure: Measure,
  suffixes: readonly S[],
): EdfSignalHeader<`${P}.${S}`>[] =>
  suffixes.map((suffix) => signal(`${prefix}.${suffix}`, measure, 1));

const index = <const L extends string>(label: L): EdfSignalHeader<L> =>
  signal(label, ["", "0.00", "240.00", 0, 2400], 1);

/** Describes BRP's flow signal. The `breaths` columns use its unit and decimals. */
export const FLOW = signal("Flow.40ms", ["L/s", "-2.00", "3.00", -1000, 1500], 1500);

/** BRP files store flow and pressure at 25 Hz, in 60 s records. */
const brp = {
  header: { format: EdfFormat.Edf, recordSeconds: 60 },
  signals: [FLOW, signal("Press.40ms", ["cmH2O", "0.00", "40.00", 0, 2000], 1500), crc16],
} satisfies EdfSignalFileType;

/** PLD files store one value every 2 s for each signal, in 60 s records. */
const pld = {
  header: { format: EdfFormat.Edf, recordSeconds: 60 },
  signals: [
    signal("MaskPress.2s", ["cmH2O", "0.00", "40.00", 0, 2000], 30),
    signal("Press.2s", ["cmH2O", "0.00", "30.00", 0, 1500], 30),
    signal("EprPress.2s", ["cmH2O", "0.00", "30.00", 0, 1500], 30),
    signal("Leak.2s", ["L/s", "0.00", "2.00", 0, 100], 30),
    signal("RespRate.2s", ["bpm", "0.00", "50.00", 0, 250], 30),
    signal("TidVol.2s", ["L", "0.00", "4.00", 0, 200], 30),
    signal("MinVent.2s", ["L/min", "0.00", "30.00", 0, 240], 30),
    signal("Snore.2s", ["", "0.00", "5.00", 0, 250], 30),
    signal("FlowLim.2s", ["", "0.00", "1.00", 0, 100], 30),
    crc16,
  ],
} satisfies EdfSignalFileType;

/**
 * SAD files store pulse oximetry at 1 Hz, in 60 s records. Without a sensor, every value is
 * missing.
 */
const sad = {
  header: { format: EdfFormat.Edf, recordSeconds: 60 },
  signals: [
    signal("Pulse.1s", ["bpm", "18.00", "300.00", 18, 300], 60),
    signal("SpO2.1s", ["%", "0.00", "100.00", 0, 100], 60),
    crc16,
  ],
} satisfies EdfSignalFileType;

const annotations = (
  samplesPerRecord: number,
): EdfAnnotationFileType<"EDF Annotations" | "Crc16"> => ({
  header: { format: EdfFormat.EdfPlusD, recordSeconds: 0 },
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
  header: { format: EdfFormat.Edf, recordSeconds: 86_400 },
  signals: [
    signal("Date", ["", "0.00", "24836.00", 0, 24836], 1),
    signal("MaskOn", ["min.", "0.00", "1440.00", 0, 1440], 10),
    signal("MaskOff", ["min.", "0.00", "1440.00", 0, 1440], 10),
    signal("MaskEvents", ["", "0.00", "255.00", 0, 255], 1),
    signal("Duration", ["min.", "0.00", "1440.00", 0, 1440], 1),
    signal("OnDuration", ["min.", "0.00", "1440.00", 0, 1440], 1),
    signal("PatientHours", ["hrs", "0.00", "65534.00", 0, 65534], 1),
    code("Mode"),
    code("S.RampEnable"),
    signal("S.RampTime", ["min.", "5.00", "45.00", 5, 45], 1),
    pressureSetting("S.C.StartPress"),
    pressureSetting("S.C.Press"),
    code("S.EPR.ClinEnable"),
    code("S.EPR.EPREnable"),
    signal("S.EPR.Level", ["cmH2O", "1.00", "3.00", 50, 150], 1),
    code("S.EPR.EPRType"),
    code("S.AS.Comfort"),
    pressureSetting("S.AS.StartPress"),
    pressureSetting("S.AS.MaxPress"),
    pressureSetting("S.AS.MinPress"),
    code("S.SmartStart"),
    code("S.PtAccess"),
    code("S.ABFilter"),
    code("S.Mask"),
    code("S.Tube"),
    code("S.ClimateControl"),
    code("S.HumEnable"),
    signal("S.HumLevel", ["", "1.00", "8.00", 1, 8], 1),
    code("S.TempEnable"),
    signal("S.Temp", ["°C", "16.00", "30.00", 160, 300], 1),
    code("HeatedTube"),
    code("Humidifier"),
    signal("BlowPress.95", ["cmH2O", "0.00", "45.00", 0, 2250], 1),
    signal("BlowPress.5", ["cmH2O", "0.00", "45.00", 0, 2250], 1),
    signal("Flow.95", ["L/s", "0.00", "3.00", 0, 1500], 1),
    signal("Flow.5", ["L/s", "0.00", "3.00", 0, 1500], 1),
    signal("BlowFlow.50", ["L/min", "0.00", "250.00", 0, 25000], 1),
    signal("AmbHumidity.50", ["mg/L", "0.00", "100.00", 0, 100], 1),
    signal("HumTemp.50", ["°C", "0.00", "95.00", 0, 950], 1),
    signal("HTubeTemp.50", ["°C", "0.00", "40.00", 0, 400], 1),
    signal("HTubePow.50", ["", "0.00", "100.00", 0, 100], 1),
    signal("HumPow.50", ["", "0.00", "100.00", 0, 100], 1),
    signal("SpO2.50", ["%", "0.00", "100.00", 0, 100], 1),
    signal("SpO2.95", ["%", "0.00", "100.00", 0, 100], 1),
    signal("SpO2.Max", ["%", "0.00", "100.00", 0, 100], 1),
    signal("SpO2Thresh", ["min.", "0.00", "1440.00", 0, 1440], 1),
    ...statistics("MaskPress", ["cmH2O", "0.00", "30.00", 0, 1500], TYPICAL),
    ...statistics("TgtIPAP", ["cmH2O", "0.00", "30.00", 0, 1500], TYPICAL),
    ...statistics("TgtEPAP", ["cmH2O", "0.00", "30.00", 0, 1500], TYPICAL),
    ...statistics("Leak", ["L/s", "0.00", "2.00", 0, 100], ["50", "95", "70", "Max"]),
    ...statistics("MinVent", ["L/min", "0.00", "30.00", 0, 240], TYPICAL),
    ...statistics("RespRate", ["bpm", "0.00", "50.00", 0, 250], TYPICAL),
    ...statistics("TidVol", ["L", "0.00", "4.00", 0, 200], TYPICAL),
    index("AHI"),
    index("HI"),
    index("AI"),
    index("OAI"),
    index("CAI"),
    index("UAI"),
    index("RIN"),
    signal("CSR", ["", "0.00", "1440.00", 0, 1440], 1),
    code("Fault.Device"),
    code("Fault.Alarm"),
    code("Fault.Humidifier"),
    code("Fault.HeatedTube"),
    crc16,
  ],
} satisfies EdfSignalFileType;

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
export const PLD_SAMPLE_SECONDS =
  pld.header.recordSeconds / (pld.signals[0]?.samplesPerRecord ?? 1);

/** Maps each event type that the machine scores to the label that it writes in EVE files. */
export const EVENT_LABELS: Readonly<Record<Exclude<EventType, EventType.Other>, string>> = {
  [EventType.ObstructiveApnea]: "Obstructive Apnea",
  [EventType.CentralApnea]: "Central Apnea",
  [EventType.UnclassifiedApnea]: "Apnea",
  [EventType.Hypopnea]: "Hypopnea",
  [EventType.Arousal]: "Arousal",
};
