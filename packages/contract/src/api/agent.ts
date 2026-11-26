import { z } from "zod";

/** An agent result has at most this many rows. */
export const AGENT_ROW_LIMIT = 200;
/** An agent result's text is at most this many characters long, including the links. */
export const AGENT_CHARACTER_LIMIT = 25_000;
/** Tells the agent how to get the rows that a cut result left out. */
export const AGENT_HINT =
  "The result was cut short. Aggregate, filter, or narrow the night range to get all of it.";

const cell = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export type AgentCell = z.infer<typeof cell>;

const table = {
  columns: z.array(z.string()),
  /**
   * Each row is an array of cells in column order. Naming the columns once makes the text about
   * 40% shorter than repeating the names in every row.
   */
  rows: z.array(z.array(cell)),
  /** Opens this query in the explorer. */
  link: z.string(),
  short_link: z.string(),
};

/**
 * Describes the compact JSON text that a query tool returns to an agent. Only a cut result has a
 * hint.
 */
export const agentResult = z.discriminatedUnion("truncated", [
  z.strictObject({ ...table, truncated: z.literal(false) }),
  z.strictObject({ ...table, truncated: z.literal(true), hint: z.string() }),
]);
export type AgentResult = z.infer<typeof agentResult>;

type Capped<Row> =
  | { rows: Row[]; truncated: false }
  | { rows: Row[]; truncated: true; hint: string };

/**
 * Cuts rows down to what fits in one agent result. Keeps rows from the start until it reaches
 * `AGENT_ROW_LIMIT` rows or `budget` characters. It counts the length of each row's JSON, plus 1
 * for the comma before every row after the first. It keeps or drops each row whole.
 *
 * `budget` is the number of characters left for rows after the caller subtracts the rest of the
 * result: the column names, the links, and `AGENT_HINT`. Subtract the hint's length even when all
 * the rows might fit, because a cut result includes the hint.
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
