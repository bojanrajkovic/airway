# MCP

This page describes the MCP server and the tools that agents can call.

The server isn't built yet. `@airway/contract` already defines the shape of a query tool's result.

## Query results

A query tool returns one block of compact JSON text, defined by `agentResult` in `@airway/contract/api/agent`:

```json
{"columns":["hour_of_night","COUNT"],"rows":[[2,14],[3,11]],"link":"…","short_link":"…","truncated":false}
```

Each row is an array instead of an object. The column names appear once, so the result has about 40% fewer characters.

`link` is the explorer link that opens the same query, and `short_link` is its `/s/<code>` form ([Links](explorer.md#links)).

## Caps

A result has at most 200 rows and at most 25,000 characters. Every character takes up space in the agent's context, and an agent can't make good use of more than 200 rows.

`capForAgent(rows, budget)` applies both caps. It keeps the leading rows that fit and drops the rest, so every row in the result is complete. `budget` is the number of characters left from the 25,000 once the rest of the result is counted.

A cut result has `truncated: true` and a `hint` that tells the agent to aggregate, filter, or narrow the night range. Only a cut result has a hint.
