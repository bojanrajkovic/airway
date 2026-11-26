import { describe, expect, it } from "vitest";
import { transformer } from "../src/transformer.ts";

describe("transformer", () => {
  it("round-trips Temporal values inside other data", () => {
    const value = {
      at: Temporal.Instant.from("2026-01-15T12:00:00.5Z"),
      nights: [Temporal.PlainDate.from("2026-01-14")],
      deviceStart: Temporal.PlainDateTime.from("2026-01-14T22:31:05"),
      cutoff: Temporal.PlainTime.from("15:00"),
      label: "Sam",
    };

    const back = transformer.parse<typeof value>(transformer.stringify(value));

    expect(back.at).toBeInstanceOf(Temporal.Instant);
    expect(back.at.equals(value.at)).toBe(true);
    expect(back.nights[0]).toBeInstanceOf(Temporal.PlainDate);
    expect(back.nights[0]?.equals("2026-01-14")).toBe(true);
    expect(back.deviceStart).toBeInstanceOf(Temporal.PlainDateTime);
    expect(back.deviceStart.equals(value.deviceStart)).toBe(true);
    expect(back.cutoff).toBeInstanceOf(Temporal.PlainTime);
    expect(back.cutoff.equals(value.cutoff)).toBe(true);
    expect(back.label).toBe("Sam");
  });
});
