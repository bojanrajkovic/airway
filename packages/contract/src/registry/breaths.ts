import { hourOfNight, night, seconds, segment, session, ts } from "./columns.ts";
import { metric, signal, type Dataset } from "./define.ts";

export const breaths: Dataset = {
  name: "breaths",
  description: "One row per breath airway detects in the 25 Hz flow signal.",
  columns: [
    night,
    ts("When the in-breath starts."),
    session,
    segment,
    hourOfNight,
    metric("duration", seconds, "Length of the breath, in-breath and out-breath together."),
    signal("amplitude", "Peak flow of the in-breath, in the flow signal's unit."),
    signal("inspiratory_volume", "Air breathed in: the in-breath's flow added up over time."),
  ],
};
