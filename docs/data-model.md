# Data model

The datasets, the derived tables, their units, and derived_version.

The column types and unit conversion are built. The datasets and the derived tables aren't yet.

## Columns

A dataset is a list of columns, and each column is described once, in `@airway/contract/registry`. Everything that queries a dataset reads that one description.

`registry/define.ts` has one function per kind of column:

| Function | Role | For |
|---|---|---|
| `signal(name, description)` | metric | A value the machine recorded. Its unit comes from the file header ([Units](#units)) |
| `metric(name, unit, description)` | metric | A value airway computes, in a unit airway chooses |
| `dimension(name, kind, description)` | dimension | An integer or boolean to filter and group by |
| `enumeration(name, values, description)` | dimension | One of a fixed list of spelled-out values |
| `time(name, kind, description)` | time | A timestamp or a night |

Time and dimension columns can be grouped by, and metrics can't. `operationsFor(column)` gives the filter operations a column allows, which follow from its kind, so no column lists its own.

## Column SQL

A column's SQL is a `TrustedSql`: SQL that came from source code and never from a request, so it's safe to put in a statement. Only a computed column has one. It writes its SQL in a `sql` template, which accepts only another `TrustedSql` or the `homeZone` marker between its text, so interpolating any other value fails to compile.

A plain column has no SQL: it's the table column of its own name, and whoever builds a statement quotes that name.

```ts
const hour = sql`extract(hour from ts at time zone ${homeZone})::int`;
const hourOfNight = dimension("hour_of_night", "integer", "Wall-clock hour in the home time zone.", hour);

render(hour, { homeZone: 3 });
// extract(hour from ts at time zone $3)::int
```

`homeZone` stands for the `AIRWAY_TIME_ZONE` setting. `render` replaces it with the number of a bound parameter, so the registry names no zone and the zone never becomes SQL text.

## Units

A stored value keeps the machine's unit. The app shows some units as others: L/s as L/min, and L as mL.

A machine signal's unit and decimals aren't in the registry. Each EDF file's header declares a signal's unit and its physical and digital ranges, which give the step between two values. `decimalsForStep(step)` turns the step into the decimals needed to write every value. For example, an AirSense 10 declares leak in L/s with a step of 0.02, so leak has 2 decimals. Another model or firmware can declare a different unit or step, and nothing in the code assumes these. A column airway computes declares its unit and decimals in the registry.

`toDisplay(value, stored)` and `toStored(value, stored)` convert between the stored and display units. A stored value converts to display and back exactly.

For example, with leak stored in L/s and tidal volume in L, as an AirSense 10 declares them:

| Stored | Shown |
|---|---|
| 0.4 L/s | 24 L/min |
| 1.14 L/s | 68.4 L/min |
| 0.3 L | 300 mL |

`toStored` is how a value typed in display units becomes one to compare with stored values: a leak of 24 L/min is a stored 0.4.
