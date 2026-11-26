import { hourOfNight, night, seconds, segment, session, ts } from "./columns.ts";
import { Granularity, metric, signal, type Dataset } from "./define.ts";

export const breaths: Dataset = {
  name: "breaths",
  description: "One row per breath that airway detects in the 25 Hz flow signal.",
  grain: Granularity.TwoSeconds,
  columns: [
    night,
    ts("When the in-breath starts."),
    session,
    segment,
    hourOfNight,
    metric("duration", seconds, "Length of the breath, in-breath and out-breath together."),
    signal("amplitude", "Peak flow of the in-breath, in the flow signal's unit."),
    signal("inspiratory_volume", "Air breathed in, summed from the in-breath's flow over time."),
  ],
};
