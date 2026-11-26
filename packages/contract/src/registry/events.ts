import { valuesOf } from "../enum.ts";
import { EventSource, EventType } from "../derived/values.ts";
import { hourOfNight, night, seconds, session, ts } from "./columns.ts";
import { dimension, enumeration, metric, type Dataset } from "./define.ts";

export const events: Dataset = {
  name: "events",
  description: "One row per breathing event the machine flagged.",
  grain: "2s",
  columns: [
    night,
    ts("When the machine marked the event."),
    session,
    hourOfNight,
    enumeration("type", valuesOf(EventType), "What kind of event it is."),
    enumeration(
      "source",
      valuesOf(EventSource),
      "Whether the machine (resmed) or airway scored the event.",
    ),
    dimension(
      "outside_mask_on",
      "boolean",
      "True when the event falls outside every mask-on period and airway assigned it to the nearest period.",
    ),
    metric(
      "duration",
      seconds,
      "How long the event lasted. The duration is empty for hypopneas and arousals because the machine doesn't time them.",
    ),
  ],
};
