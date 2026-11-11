import { EVENT_SOURCES, EVENT_TYPES } from "../derived/values.ts";
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
    enumeration("type", EVENT_TYPES, "What kind of event it is."),
    enumeration("source", EVENT_SOURCES, "Who scored it: the machine (resmed) or airway."),
    dimension(
      "outside_mask_on",
      "boolean",
      "True when the event falls outside every mask-on period and was given to the nearest one.",
    ),
    metric(
      "duration",
      seconds,
      "How long the event lasted. Empty for hypopneas and arousals, which the machine doesn't time.",
    ),
  ],
};
