import { valuesOf } from "../enum.ts";
import { SessionSource } from "../derived/values.ts";
import { minutes, night, session, ts } from "./columns.ts";
import { enumeration, metric, sql, time, type Dataset } from "./define.ts";

export const sessions: Dataset = {
  name: "sessions",
  description: "Each row is one mask-on period.",
  grain: "2s",
  columns: [
    night,
    ts("When the mask went on."),
    time("ended_at", "timestamp", "When the mask came off."),
    session,
    enumeration(
      "source",
      valuesOf(SessionSource),
      "The period comes from the machine's stored mask-on times (str) or from the recording files (derived). On a night with more periods than the machine stores, airway reads the periods from the recording files.",
    ),
    metric(
      "duration",
      minutes,
      "How long the mask stayed on.",
      sql`(extract(epoch from ended_at - ts) / 60)::double precision`,
    ),
  ],
};
