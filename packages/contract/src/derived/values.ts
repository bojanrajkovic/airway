// Each enum lists the values that one text column accepts. `ddl.ts` builds the tables' CHECK
// constraints from these enums.

/** Lists the outcomes of comparing a night's event count with the machine's AHI. */
export enum AhiOutcome {
  Match = "match",
  Mismatch = "mismatch",
  NoUsage = "no_usage",
}

/**
 * Lists the sources that a session can come from. A `str` session comes from a mask-on and mask-off pair in
 * STR.edf. A `derived` session comes from BRP files.
 */
export enum SessionSource {
  Str = "str",
  Derived = "derived",
}

export enum EventType {
  ObstructiveApnea = "obstructive_apnea",
  CentralApnea = "central_apnea",
  UnclassifiedApnea = "unclassified_apnea",
  Hypopnea = "hypopnea",
  Arousal = "arousal",
  Other = "other",
}

export enum EventSource {
  Resmed = "resmed",
  AirwayCandidate = "airway_candidate",
}

export enum FileKind {
  Brp = "brp",
  Pld = "pld",
  Eve = "eve",
  Str = "str",
  Identification = "identification",
  Crc = "crc",
}

/**
 * Lists the results of comparing a file with its `.crc` file. `Unchecked` means the file has no
 * `.crc`, or ingest doesn't read the file.
 */
export enum FileChecksum {
  Match = "match",
  Mismatch = "mismatch",
  Unchecked = "unchecked",
}

export enum Period {
  Week = "week",
  Month = "month",
}

/** Lists the sample signals that airway stores weekly and monthly percentiles for. */
export enum PercentileSignal {
  Leak = "leak",
  MaskPressure = "mask_pressure",
}
