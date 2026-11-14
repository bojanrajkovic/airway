import type { EVENT_TYPES } from "../derived/values.ts";

// Invented round numbers that look like a child or an adult on an AutoSet machine. None come from
// a real patient.

export const PATIENTS = ["child", "adult"] as const;
export type Patient = (typeof PATIENTS)[number];

/** The event types the machine scores. */
export const MACHINE_EVENT_TYPES = [
  "obstructive_apnea",
  "central_apnea",
  "unclassified_apnea",
  "hypopnea",
  "arousal",
] as const satisfies readonly (typeof EVENT_TYPES)[number][];
export type MachineEventType = (typeof MACHINE_EVENT_TYPES)[number];

export type Breathing = {
  /** Breaths per minute: the night's mean, and how much it varies between nights. */
  rate: { mean: number; sd: number };
  /** Litres per breath. */
  tidalVolume: { mean: number; sd: number };
  /** Events per hour of use on an ordinary night. */
  eventsPerHour: Readonly<Record<MachineEventType, number>>;
  /** Pauses too short for the machine's 10 s apnea limit but at least 2 breaths long. */
  pediatricPausesPerHour: number;
  /** Dips in flow shorter than 2 breaths, which nothing should flag. */
  dipsPerHour: number;
  /** Unintentional leak between spikes, in L/s. */
  leak: number;
  /** The AutoSet pressure range in cmH2O, written as S.AS.MinPress and S.AS.MaxPress. */
  pressure: { min: number; max: number };
  /** How far expiratory relief lowers the pressure, in cmH2O, written as S.EPR.Level. */
  epr: number;
  /** Every other S.* setting in STR.edf, by label. The model copies them into STR.edf as they are. */
  settings: Readonly<Record<string, number>>;
};

// Codes for the on/off and choice settings. The values are invented but stay in their 0 to 16 range.
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
  // Children breathe faster and smaller, and their pauses reach 2 breaths well before 10 s.
  child: {
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
  adult: {
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
