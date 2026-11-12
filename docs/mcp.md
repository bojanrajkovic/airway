# MCP

The MCP server and the tools it gives agents.

The server isn't built yet. The shape of a query tool's result is.

## Query results

A query tool returns one block of compact JSON text, defined by `agentResult` in `@airway/contract/api/agent`:

```json
{"columns":["hour_of_night","COUNT"],"rows":[[2,14],[3,11]],"link":"…","short_link":"…","truncated":false}
```

Rows are arrays, not objects. The column names then appear once, which saves about 40% of the characters.

`link` is the explorer link that opens the same query, and `short_link` is its `/s/<code>` form ([Links](explorer.md#links)).

## Caps

One result carries at most 200 rows and at most 25,000 characters, whichever runs out first. An agent's context pays for every character, and 200 rows is more than an agent reads usefully.

`capForAgent(rows, budget)` applies both. It keeps the leading rows that fit and never part of a row. `budget` is what's left of the 25,000 characters after the rest of the result.

A cut result has `truncated: true` and a `hint` that tells the agent to aggregate, filter, or narrow the night range. Only a cut result has a hint.
