// This file doesn't import drizzle, so the web app can import these enums.

/** Lists the categories that a note can be in. A `finding` note also has a row in `findings`. */
export enum NoteCategory {
  Procedure = "procedure",
  Study = "study",
  Medication = "medication",
  Illness = "illness",
  Equipment = "equipment",
  Finding = "finding",
  Other = "other",
}

/** Lists the precisions that a note's dates can have. */
export enum DatePrecision {
  Day = "day",
  Month = "month",
  Year = "year",
}

/** Lists the kinds of query that a short link can open. */
export enum ShortLinkKind {
  Spec = "spec",
  Sql = "sql",
}
