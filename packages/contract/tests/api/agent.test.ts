import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AGENT_HINT, AGENT_ROW_LIMIT, capForAgent, type AgentCell } from "../../src/api/agent.ts";

const rowsOf = (count: number): AgentCell[][] =>
  Array.from({ length: count }, (_, index) => [index, "2031-03-01"]);
/** The characters the rows take inside a JSON array, without its brackets. */
const lengthOf = (rows: readonly (readonly AgentCell[])[]): number =>
  Math.max(0, JSON.stringify(rows).length - 2);

describe("capForAgent", () => {
  it("leaves a short result alone", () => {
    const rows = rowsOf(AGENT_ROW_LIMIT);

    expect(capForAgent(rows, 25_000)).toEqual({ rows, truncated: false });
  });

  it("cuts at the row limit, and says how to get the rest", () => {
    const rows = rowsOf(AGENT_ROW_LIMIT + 1);

    expect(capForAgent(rows, 25_000)).toEqual({
      rows: rows.slice(0, AGENT_ROW_LIMIT),
      truncated: true,
      hint: AGENT_HINT,
    });
  });

  it("cuts earlier when the characters run out", () => {
    const rows = [["a".repeat(10)], ["b".repeat(10)], ["c".repeat(10)]];
    // Each row is 14 characters, and two rows with their comma are 29.
    const { rows: kept, truncated } = capForAgent(rows, 29);

    expect(kept).toEqual(rows.slice(0, 2));
    expect(truncated).toBe(true);
    expect(capForAgent(rows, 28).rows).toEqual(rows.slice(0, 1));
  });

  it("keeps the most leading rows that fit, each one whole", () => {
    const cell = fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null));
    const rows = fc.array(fc.array(cell, { maxLength: 5 }), { maxLength: 300 });

    fc.assert(
      fc.property(rows, fc.nat(4000), (all, budget) => {
        const { rows: kept, truncated } = capForAgent(all, budget);
        const next = all.slice(0, kept.length + 1);

        expect(kept).toEqual(all.slice(0, kept.length));
        expect(lengthOf(kept)).toBeLessThanOrEqual(budget);
        expect(truncated).toBe(kept.length < all.length);
        expect(!truncated || kept.length === AGENT_ROW_LIMIT || lengthOf(next) > budget).toBe(true);
      }),
    );
  });
});
