import { z } from "zod";

/** The most rows one agent result carries. */
export const AGENT_ROW_LIMIT = 200;
/** The most characters one agent result's text runs to, links and all. */
export const AGENT_CHARACTER_LIMIT = 25_000;
/** What a cut result tells the agent to do next. */
export const AGENT_HINT =
  "The result was cut short. Aggregate, filter, or narrow the night range to get all of it.";

const cell = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export type AgentCell = z.infer<typeof cell>;

const table = {
  columns: z.array(z.string()),
  /** Arrays, not objects: the column names appear once, which saves about 40% of the text. */
  rows: z.array(z.array(cell)),
  /** The explorer link that opens the same query. */
  link: z.string(),
  short_link: z.string(),
};

/** What a query tool returns to an agent, as compact JSON text. Only a cut result has a hint. */
export const agentResult = z.discriminatedUnion("truncated", [
  z.strictObject({ ...table, truncated: z.literal(false) }),
  z.strictObject({ ...table, truncated: z.literal(true), hint: z.string() }),
]);
export type AgentResult = z.infer<typeof agentResult>;

type Capped<Row> =
  | { rows: Row[]; truncated: false }
  | { rows: Row[]; truncated: true; hint: string };

/**
 * Keeps the leading rows that fit: at most `AGENT_ROW_LIMIT`, and at most `budget` characters as
 * JSON with a comma between rows. A row is kept whole or left out. The budget is what's left of
 * `AGENT_CHARACTER_LIMIT` after everything else in the result, with room for `AGENT_HINT` already
 * taken out: a cut result carries it.
 */
export function capForAgent<Row extends readonly AgentCell[]>(
  rows: readonly Row[],
  budget: number,
): Capped<Row> {
  let used = 0;
  const fits = rows.slice(0, AGENT_ROW_LIMIT).findIndex((row, index) => {
    used += JSON.stringify(row).length + (index === 0 ? 0 : 1);

    return used > budget;
  });
  const kept = fits === -1 ? rows.slice(0, AGENT_ROW_LIMIT) : rows.slice(0, fits);

  return kept.length === rows.length
    ? { rows: kept, truncated: false }
    : { rows: kept, truncated: true, hint: AGENT_HINT };
}
