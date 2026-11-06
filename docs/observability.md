# Observability

## Logs

The server logs JSON lines to stdout with pino, through the root logger from `packages/server/src/logger.ts`. Each line carries `service: "airway"` and its level as a name, such as `"info"`, so log queries can filter on it. `LOG_LEVEL` sets the lowest level logged.

Each module logs through a child logger with its name bound, `ctx.logger.child({ module: "http" })`, and adds the ids of the work it's doing.

Logs carry ids, counts, and outcomes, never values from the data. As a backstop, the logger redacts these fields wherever they appear: `authorization`, `cookie`, `password`, `birthDate`, `databaseUrl`, `readerDatabaseUrl`, and the identity proxy's JWT header.

`pnpm dev` prints the server's logs through pino-pretty; production logs stay JSON.

Traces and metrics aren't built yet.
