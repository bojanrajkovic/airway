// How tRPC carries values the server and the web app share. JSON has no Temporal types, so superjson
// sends each as its ISO string and rebuilds it on the other side.
import { SuperJSON } from "superjson";

export const transformer = new SuperJSON();

transformer.registerCustom<Temporal.Instant, string>(
  {
    isApplicable: (value): value is Temporal.Instant => value instanceof Temporal.Instant,
    serialize: (value) => value.toString(),
    deserialize: (text) => Temporal.Instant.from(text),
  },
  "Temporal.Instant",
);

transformer.registerCustom<Temporal.PlainDate, string>(
  {
    isApplicable: (value): value is Temporal.PlainDate => value instanceof Temporal.PlainDate,
    serialize: (value) => value.toString(),
    deserialize: (text) => Temporal.PlainDate.from(text),
  },
  "Temporal.PlainDate",
);
