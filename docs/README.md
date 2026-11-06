# airway docs

One page per area. Each page describes how that area works now. A page whose area isn't built yet says so.

## Working on airway

- [Development](development.md): setup, scripts, the workspace layout, dependencies, lint, and pull requests
- [Testing](testing.md): the test projects, where tests go, and database tests
- [Synthetic data](synthetic-data.md): the generated SD-card data tests and screenshots use
- [CI](ci.md): the jobs, the Check gate, and the ruleset on main
- [Release](release.md): versions, releases, and the published image

## Running airway

- [Configuration](configuration.md): every environment variable the server reads
- [Operations](operations.md): deploying, the rebuild command, and runbooks
- [Observability](observability.md): traces, logs, and metrics, and what's never recorded
- [Auth](auth.md): how requests are signed and checked

## Inside airway

- [Server](server.md): the HTTP server, startup, and the API
- [Data model](data-model.md): datasets, derived tables, units, and `derived_version`
- [Scoring](scoring.md): how airway's numbers are computed and labeled
- [Ingest](ingest.md): reading the CPAP data folder into the derived tables
- [Query](query.md): compiling builder queries and running SQL read-only
- [Notes](notes.md): notes, findings, and snapshots
- [MCP](mcp.md): the MCP server and its tools

## The web app

- [Web](web.md): tokens, components, routes, and time display
- [Charts](charts.md): the shared chart component
- [Trends](trends.md): the trends page and night summaries
- [Explorer](explorer.md): the explorer, its links, and query history
- [Waveforms](waveforms.md): the waveform viewer
