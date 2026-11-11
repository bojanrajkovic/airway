import { SESSION_SOURCES } from "../derived/values.ts";
import { minutes, night, session, ts } from "./columns.ts";
import { enumeration, metric, sql, time, type Dataset } from "./define.ts";

export const sessions: Dataset = {
  name: "sessions",
  description: "One row per mask-on period.",
  grain: "2s",
  columns: [
    night,
    ts("When the mask went on."),
    time("ended_at", "timestamp", "When the mask came off."),
    session,
    enumeration(
      "source",
      SESSION_SOURCES,
      "Where the period comes from: the machine's own mask-on times (str), or airway's reading of the recording files (derived) on a night with more periods than the machine stores.",
    ),
    metric(
      "duration",
      minutes,
      "Length of the period.",
      sql`(extract(epoch from ended_at - ts) / 60)::double precision`,
    ),
  ],
};
