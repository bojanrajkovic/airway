import { hourOfNight, night, segment, session, ts } from "./columns.ts";
import { Granularity, signal, type Dataset } from "./define.ts";

export const samples: Dataset = {
  name: "samples",
  description: "The machine's low-rate signals, one row per 2 seconds of therapy.",
  grain: Granularity.TwoSeconds,
  columns: [
    night,
    ts("When the 2 seconds start."),
    session,
    segment,
    hourOfNight,
    signal("mask_pressure", "Pressure measured at the mask."),
    signal("pressure", "Pressure that the machine delivers."),
    signal("epr_pressure", "Pressure after expiratory relief lowers it on the out-breath."),
    signal("leak", "Air that leaks out anywhere other than the mask's built-in vent."),
    signal("respiratory_rate", "Breaths per minute."),
    signal("tidal_volume", "Air moved by one breath."),
    signal("minute_ventilation", "Air moved per minute."),
    signal("snore", "The machine's snore index, 0 to 5."),
    signal("flow_limitation", "How flattened the in-breath is, 0 (round) to 1 (flat)."),
  ],
};
