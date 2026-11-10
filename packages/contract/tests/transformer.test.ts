import { describe, expect, it } from "vitest";
import { transformer } from "../src/transformer.ts";

describe("transformer", () => {
  it("round-trips Temporal values inside other data", () => {
    const value = {
      at: Temporal.Instant.from("2026-01-15T12:00:00.5Z"),
      nights: [Temporal.PlainDate.from("2026-01-14")],
      label: "Sam",
    };

    const back = transformer.parse<typeof value>(transformer.stringify(value));

    expect(back.at).toBeInstanceOf(Temporal.Instant);
    expect(back.at.equals(value.at)).toBe(true);
    expect(back.nights[0]).toBeInstanceOf(Temporal.PlainDate);
    expect(back.nights[0]?.equals("2026-01-14")).toBe(true);
    expect(back.label).toBe("Sam");
  });
});
