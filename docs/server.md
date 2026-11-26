# Server

The server in `packages/server` is one Node process, a Hono app that serves the API and the built web app. `src/main.ts` is the entry point, and Rolldown bundles it to `dist/main.js`. Rolldown bundles the telemetry preload, `src/instrument.ts`, on its own to `dist/instrument.js`, and `node --import` runs the preload first ([Observability](observability.md#telemetry-startup)).

## Startup and shutdown

```mermaid
sequenceDiagram
  participant Main as main.ts
  participant Config as config.ts
  participant HTTP as HTTP listener
  participant Stack as AsyncDisposableStack
  Main->>Config: loadConfig()
  Config-->>Main: config, or problems (exit 1)
  Main->>Main: create the root logger and AppContext
  Main->>HTTP: listen on PORT
  HTTP->>Stack: register close()
  Note over Main,Stack: later startup work runs here, while /healthz already answers
  Main->>Stack: SIGTERM or SIGINT: disposeAsync()
  Stack->>HTTP: close, in reverse order of registration
```

The listener starts before anything else, so the pod answers `/healthz` while slower startup work runs. Each component that holds a resource registers its cleanup with one `AsyncDisposableStack`. On SIGTERM or SIGINT, the stack runs the cleanups in reverse order of registration.

## Shared dependencies

`src/runtime/context.ts` defines `AppContext`: the config, the root logger, a clock, the database pools, and the night pool ([Ingest](ingest.md#night-pool)). `main.ts` builds the context once and passes the whole context to the code that needs it. A service takes the context plus its own arguments, and logs through `ctx.logger.child({ module })`. Tests build a context with `testContext()` from `tests/support/context.ts`. That context has synthetic config, a silent logger, a fixed clock, database pools that connect only when a test queries them, and a stub night pool whose `run` returns `worker_failed` for every night.

## Database pools

`createPools(config, logger)` in `src/db/pools.ts` creates three pools that connect to `DATABASE_URL`, and `main.ts` puts them on `ctx.db`:

| Pool | Size | `statement_timeout` | `search_path` | Used for |
|---|---|---|---|---|
| `write` | 5 | none | Postgres's default | every write, through Drizzle (`ctx.db.write.db`) |
| `api` | 5 | 10 s | `derived` | the web API's queries |
| `agent` | 3 | 15 s | `derived` | agents' queries over MCP |

Each pool's connections appear in `pg_stat_activity` as `airway-<pool>`. The `api` and `agent` pools set `search_path`, so SQL from the explorer or an agent can name a table such as `nights` without its schema.

Pools connect on their first query, so a server with no database still starts and answers `/healthz`. Shutdown closes the pools after the listener stops. When an idle connection drops, the pool logs the error and opens a replacement on the next query.

Each pool parses three Postgres types into the types that airway uses:

- `timestamptz` to `Temporal.Instant`
- `date` to `Temporal.PlainDate`
- `int8`, such as `count(*)`, to `number`. The parser throws a `RangeError` for a value past 2^53, because `number` would round the value.

Each pool sets its own parsers and leaves pg's global `types` unchanged, so other pg clients in the process, such as the test database fixture, keep pg's defaults.

## Routes

`createApp(ctx, { webRoot })` in `src/http/app.ts` builds the app:

- `createApp` sets the Content-Security-Policy header from `@airway/contract/csp` on every response, including 404s and errors.
- `GET /healthz` answers `{"status":"ok"}`.
- `/assets/*` serves the web build's hashed files and returns 404 for a file that's missing.
- Any other `GET` returns `index.html`, so a deep link such as `/explore?q=…` loads the web app, which reads the URL.
- The `onError` handler logs an unhandled error and returns a plain-text 500 response without the error's details.

Each module that serves HTTP exports `routes(ctx): Hono` from its own folder, such as `src/mcp/routes.ts`. `createApp` mounts each module's routes with `app.route(path, routes(ctx))` before it adds the deep-link fallback. A module's middleware stays inside its own sub-app. The one exception is `requireAuthor`. `createApp` itself mounts `requireAuthor` on `/trpc/*` and `/mcp`, so every route under those paths runs it ([Auth](auth.md)).

## tRPC

The web app calls the server through tRPC, which `createApp` mounts at `/trpc` behind `requireAuthor` ([Auth](auth.md)). `src/trpc/router.ts` defines `appRouter`, and the web app imports its type, `AppRouter`, from `@airway/server/trpc` to get a typed client. `AppRouter` is only a type, so TypeScript erases the import when it compiles the web app.

tRPC serializes values with `transformer` from `@airway/contract/transformer`, which is superjson with `Temporal.Instant` and `Temporal.PlainDate` registered. A procedure can return a `Temporal.Instant` or a `Temporal.PlainDate`, and the client receives the same type. The client may send a query as a POST, because explorer queries can be too long for a URL.

Every procedure builds on `procedure` from `src/trpc/init.ts`. Its `ctx` has:

- `app`: the `AppContext`
- `author`: the caller, which `requireAuthor` identifies
- `signal`: a signal that aborts when the client disconnects
- `log`: a child logger bound to `module: "trpc"` and the procedure's path

A procedure is a controller: it parses input, calls a service, and maps the result. A service returns a `Result` with its own error union and never imports tRPC. `toTRPC(result, codeFor)` in `src/trpc/errors.ts` returns the `Ok` value, or throws a `TRPCError` with the code that `codeFor` returns for the error. Each service has one `codeFor` that covers its whole union, so the build fails on a new error case until `codeFor` maps that case:

```ts
const nightsCode = (error: NightsError): TRPC_ERROR_CODE_KEY => {
  switch (error.kind) {
    case "not_found":
      return "NOT_FOUND";
  }
};

export const nightsRouter = router({
  get: procedure
    .input(NightInput)
    .query(({ ctx, input }) => toTRPC(getNight(ctx.app, input.night), nightsCode)),
});
```

The `TRPCError` contains only the code. The service has already logged the failure ([Observability](observability.md#errors)), so the details stay on the server.

Each call runs in a span named `trpc.<path>` and records its duration on the `rpc.server.call.duration` histogram. The server sets `rpc.method` to the procedure's path on both the span and the histogram point. When a call fails, the span records the tRPC code as `error.type`. Only a code that maps to a 5xx marks the span as an error. The server keeps procedure inputs out of the span and the histogram.

### Procedures

The contract defines the inputs and return types of the procedures in this table. The router serves only `ping`. The input schemas and return types are in these `@airway/contract` modules:

- Queries: `api/procedures` and `query/spec`
- Notes: `notes/api`
- Trends: `api/summary`
- Waveforms: `api/waveform`
- App: `api/status`

A zod schema validates each procedure's input. The server sends each output without validating it. The server's types guarantee each output, and rows from Postgres are parsed where they're read. A run that records history is a mutation, because it writes.

| Procedure | Kind | Input | Returns |
|---|---|---|---|
| `query.run` | mutation | `querySpec` | `QueryResult & RunLinks` |
| `query.tile` | query | `querySpec` | `QueryResult` |
| `query.rows` | query | `BucketSelection` | `BucketRows` |
| `sql.run` | mutation | `SqlStatement` | `SqlResult & { shortLink: string }` |
| `links.resolve` | query | `LinkCode` | `ShortLinkTarget` |
| `history.list` | query | `ListHistory` | `HistoryPage` |
| `notes.list` | query | `ListNotes` | `Note[]` |
| `notes.get` | query | `NoteId` | `Note` |
| `notes.add` | mutation | `AddNote` | `Note` |
| `notes.update` | mutation | `UpdateNote` | `Note` |
| `notes.delete` | mutation | `NoteId` | nothing |
| `notes.restore` | mutation | `NoteId` | `Note` |
| `findings.get` | query | `NoteId` | `Finding` |
| `findings.runNow` | mutation | `NoteId` | `Snapshot` |
| `summary.lastNight` | query | none | `LastNightSummary` |
| `summary.range` | query | `SummaryRange` | `RangeSummary` |
| `summary.settingsChanges` | query | `NightRange` | `SettingChange[]` |
| `waveform.window` | query | `WaveformWindow` | `WaveformData` |
| `waveform.night` | query | `WaveformNight` | `WaveformOverview` |
| `app.status` | query | none | `AppStatus` |

MCP's `save_finding` calls the findings service directly, so the table lists only `findings.get` and `findings.runNow`.

## The web build

`pnpm build` builds the web app into `packages/server/dist/public/`, next to the server bundle, where `main.ts` looks for it. With no build there, as in `pnpm dev`, the server serves only the API, and Vite serves the web app.

## Dependencies in the bundle

Packages listed under `dependencies` in `packages/server/package.json` stay external, and Node loads them from `node_modules`. Rolldown bundles workspace packages, such as `@airway/contract`.
