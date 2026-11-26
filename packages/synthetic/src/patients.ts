import type { EVENT_TYPES } from "@airway/contract/derived/values";

// These round numbers are invented. They resemble how a child and an adult breathe on an AutoSet
// machine.

export const PATIENTS = ["child", "adult"] as const;
export type Patient = (typeof PATIENTS)[number];

/** Lists the event types that the machine scores. */
export const MACHINE_EVENT_TYPES = [
  "obstructive_apnea",
  "central_apnea",
  "unclassified_apnea",
  "hypopnea",
  "arousal",
] as const satisfies readonly (typeof EVENT_TYPES)[number][];
export type MachineEventType = (typeof MACHINE_EVENT_TYPES)[number];

/** Lists the machine's apnea types. Each apnea also appears as a gap in the flow signal. */
export const APNEAS: ReadonlySet<(typeof EVENT_TYPES)[number]> = new Set<MachineEventType>([
  "obstructive_apnea",
  "central_apnea",
  "unclassified_apnea",
]);

/**
 * Lists whole-number ranges. The model chooses a range in proportion to its weight, and each range
 * includes its `max`.
 */
export type WeightedRanges = readonly { weight: number; min: number; max: number }[];

export type Breathing = {
  /** Mask-on periods per night. */
  periods: WeightedRanges;
  /** Seconds between consecutive BRP files inside one mask-on period. */
  fileGaps: WeightedRanges;
  /** Breaths per minute. `mean` is a night's average, and `sd` is how much nights differ. */
  rate: { mean: number; sd: number };
  /** Litres per breath. */
  tidalVolume: { mean: number; sd: number };
  /** Events per hour of use on an ordinary night. */
  eventsPerHour: Readonly<Record<MachineEventType, number>>;
  /** Pauses per hour that last at least 2 breaths but less than the machine's 10 s apnea limit. */
  pediatricPausesPerHour: number;
  /** Dips in flow per hour. A dip lasts under 2 breaths, so it's too short to count as an event. */
  dipsPerHour: number;
  /** Unintentional leak between spikes, in L/s. */
  leak: number;
  /** The AutoSet pressure range in cmH2O. STR.edf stores it as S.AS.MinPress and S.AS.MaxPress. */
  pressure: { min: number; max: number };
  /** How far expiratory relief lowers the pressure, in cmH2O. STR.edf stores it as S.EPR.Level. */
  epr: number;
  /**
   * Maps the label of every other S.* setting in STR.edf to its value. The model copies each value
   * into STR.edf unchanged.
   */
  settings: Readonly<Record<string, number>>;
};

// These are the codes for the on/off and choice settings. The values are invented, and each one
// falls within its setting's range of 0 to 16.
const CODES = {
  "S.RampEnable": 1,
  "S.EPR.ClinEnable": 1,
  "S.EPR.EPREnable": 1,
  "S.EPR.EPRType": 0,
  "S.AS.Comfort": 0,
  "S.SmartStart": 1,
  "S.PtAccess": 1,
  "S.ABFilter": 0,
  "S.Mask": 2,
  "S.Tube": 1,
  "S.ClimateControl": 1,
  "S.HumEnable": 1,
  "S.TempEnable": 1,
};

const comfort = {
  "S.RampTime": 20,
  "S.C.StartPress": 4,
  "S.AS.StartPress": 4,
  "S.HumLevel": 4,
  "S.Temp": 27,
};

export const BREATHING: Readonly<Record<Patient, Breathing>> = {
  // Children take faster, smaller breaths, so a pause lasts 2 breaths well before it lasts 10 s.
  // A child takes the mask off often and briefly, so some nights have more mask-on periods than
  // STR.edf's 10 slots. File gaps fall on both sides of the 90 s limit that ingest uses to join
  // files into a session.
  child: {
    periods: [
      { weight: 5, min: 1, max: 10 },
      { weight: 1, min: 11, max: 20 },
    ],
    fileGaps: [
      { weight: 15, min: 5, max: 30 },
      { weight: 35, min: 30, max: 60 },
      { weight: 40, min: 60, max: 90 },
      { weight: 10, min: 90, max: 120 },
    ],
    rate: { mean: 22, sd: 1.5 },
    tidalVolume: { mean: 0.22, sd: 0.02 },
    eventsPerHour: {
      obstructive_apnea: 0.6,
      central_apnea: 0.4,
      unclassified_apnea: 0.1,
      hypopnea: 0.8,
      arousal: 0.5,
    },
    pediatricPausesPerHour: 2,
    dipsPerHour: 4,
    leak: 0.04,
    pressure: { min: 6, max: 12 },
    epr: 2,
    settings: { ...CODES, ...comfort, "S.C.Press": 8 },
  },
  // An adult has few periods and short gaps, so the sessions that ingest builds always match the
  // mask-on periods.
  adult: {
    periods: [{ weight: 1, min: 1, max: 6 }],
    fileGaps: [{ weight: 1, min: 5, max: 90 }],
    rate: { mean: 14, sd: 1 },
    tidalVolume: { mean: 0.5, sd: 0.04 },
    eventsPerHour: {
      obstructive_apnea: 1.5,
      central_apnea: 0.6,
      unclassified_apnea: 0.2,
      hypopnea: 2,
      arousal: 1,
    },
    pediatricPausesPerHour: 0.3,
    dipsPerHour: 3,
    leak: 0.08,
    pressure: { min: 7, max: 16 },
    epr: 3,
    settings: { ...CODES, ...comfort, "S.C.Press": 10 },
  },
};
