// The values each text column with a fixed set can hold. The tables' CHECK constraints are built
// from these lists.

/** How a night's event count compares with the machine's own AHI. */
export const AHI_CHECKS = ["match", "mismatch", "no_usage"] as const;
/** `str` sessions come from STR.edf's mask-on and mask-off pairs; `derived` ones from BRP files. */
export const SESSION_SOURCES = ["str", "derived"] as const;
export const EVENT_TYPES = [
  "obstructive_apnea",
  "central_apnea",
  "unclassified_apnea",
  "hypopnea",
  "arousal",
  "other",
] as const;
export const EVENT_SOURCES = ["resmed", "airway_candidate"] as const;
export const FILE_KINDS = ["brp", "pld", "eve", "str", "identification"] as const;
export const PERIODS = ["week", "month"] as const;
/** The sample signals whose weekly and monthly percentiles are stored. */
export const PERCENTILE_SIGNALS = ["leak", "mask_pressure"] as const;
