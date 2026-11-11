# Query

How builder queries are written and compiled to SQL, and how SQL runs read-only.

## The query spec

A builder query is a JSON object, the spec. It says what to compute over which rows of one dataset. The explorer's links, the builder, and the agent tools all write the same spec, and `parseSpec` in `@airway/contract/query/spec` checks every one.

The field names and operation names are Honeycomb's, because agents already write that shape.

```json
{
  "v": 1,
  "dataset": "events",
  "nights": { "last": 30 },
  "calculations": [{ "op": "COUNT" }],
  "filters": [{ "column": "type", "op": "=", "value": "obstructive_apnea" }],
  "breakdowns": ["hour_of_night"],
  "granularity": "night"
}
```

| Field | Value | Default |
|---|---|---|
| `v` | `1`, the spec's version | required |
| `dataset` | `nights`, `sessions`, `events`, `samples`, or `breaths` | required |
| `nights` | `{"last": n}` for the most recent n nights, or `{"from", "to"}` with two dates | required |
| `calculations` | Up to 10 of `{op, column}` | `[{"op": "COUNT"}]` |
| `filters` | Up to 20 of `{column, op, value}` | none |
| `filter_combination` | `AND` or `OR`, for the whole list | `AND` |
| `breakdowns` | Up to 3 columns to group by | none |
| `orders` | `{op, column, order}` for a calculation, or `{column, order}` for a breakdown | none |
| `havings` | Up to 10 of `{calculate_op, column, op, value}`, which keep the groups whose total passes | none |
| `limit` | The most groups to return, up to 1,000 | 100 |
| `granularity` | The time step to bucket by | none: totals only |

`parseSpec` returns the spec with every default filled in, or a list of issues. Each issue has the path of the wrong field, such as `filters[0].op`, and a message that lists what's allowed there. An unknown field is an issue too, so a misspelled clause isn't silently dropped.

### What the registry decides

The schema is generated from the [registry](data-model.md#columns), one variant per dataset, so a spec can only name that dataset's columns.

- **Calculations.** `COUNT` takes no column. `COUNT_DISTINCT` takes any column. `SUM`, `AVG`, and the percentiles (`P001` to `P999`) take a metric. `MIN` and `MAX` take any number, integer, timestamp, or date column, and give a value of that kind. `columnsFor(dataset, op)` lists the columns an operation takes.
- **Filters.** Each column allows the operations of its kind ([`operationsFor`](data-model.md#columns)), with values of its kind: a number, an integer, a boolean, one of an enum's values, a date, or a time. A time must carry its offset, such as `2026-06-01T02:00:00-04:00`. `in` and `not-in` take a list of up to 50 values, and `exists` and `does-not-exist` take none.
- **Breakdowns.** Any time or dimension column.
- **Granularity.** The dataset's grain or longer. `nights` allows `night`, `week`, and `month`. The other four also allow `2s`, `30s`, `1m`, `5m`, `15m`, and `1h`.

Numbers in filters and havings are in display units: a leak filter is in L/min ([Units](data-model.md#units)).

### What must agree within a spec

- A calculation, a breakdown, or an order appears once.
- An order names a calculation of the same spec by its `op` and `column`, or a breakdown by its `column`.
- A having names a calculation of the same spec, and its value fits what the calculation gives: a number, or a time or date for `MIN` and `MAX` of one.

### Generated specs

`@airway/contract/query/arbitrary` has two fast-check arbitraries built from the registry: `specInput`, a valid spec as written with optional fields left out at random, and `spec`, the same after parsing. Tests of anything that takes a spec use them.
