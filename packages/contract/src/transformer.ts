// tRPC uses this superjson instance to serialize the values that the server and the web app share.
// Plain JSON would deliver a Temporal value as a string. This instance sends the value's ISO string
// and rebuilds the Temporal value on the other side.
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
