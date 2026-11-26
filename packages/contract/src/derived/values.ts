// Each list names the values that one text column accepts. `ddl.ts` builds the tables' CHECK
// constraints from these lists.

/** Each value is a result of comparing a night's event count with the machine's AHI. */
export const AHI_CHECKS = ["match", "mismatch", "no_usage"] as const;
/**
 * A `str` session comes from a mask-on and mask-off pair in STR.edf. A `derived` session comes from
 * BRP files.
 */
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
export const FILE_KINDS = ["brp", "pld", "eve", "str", "identification", "crc"] as const;
export const PERIODS = ["week", "month"] as const;
/** airway stores weekly and monthly percentiles for these sample signals. */
export const PERCENTILE_SIGNALS = ["leak", "mask_pressure"] as const;
