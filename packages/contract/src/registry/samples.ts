import { hourOfNight, night, segment, session, ts } from "./columns.ts";
import { signal, type Dataset } from "./define.ts";

export const samples: Dataset = {
  name: "samples",
  description: "One row per 2 seconds of therapy, from the machine's low-rate signals.",
  columns: [
    night,
    ts("When the 2 seconds start."),
    session,
    segment,
    hourOfNight,
    signal("mask_pressure", "Pressure measured at the mask."),
    signal("pressure", "Pressure the machine is delivering."),
    signal("epr_pressure", "Pressure after expiratory relief lowers it on the out-breath."),
    signal("leak", "Unintentional leak, beyond the mask's built-in vent."),
    signal("respiratory_rate", "Breaths per minute."),
    signal("tidal_volume", "Air moved by one breath."),
    signal("minute_ventilation", "Air moved per minute."),
    signal("snore", "The machine's snore index, 0 to 5."),
    signal("flow_limitation", "How flattened the in-breath is, 0 (round) to 1 (flat)."),
  ],
};
