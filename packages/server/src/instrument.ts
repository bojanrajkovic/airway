// Loaded with `node --import` before the server, so instrumentation is registered before any
// dependency loads. It flushes on its own once the server has shut down. Without
// OTEL_EXPORTER_OTLP_ENDPOINT the SDK never starts: no exporters, no network calls. Everything else
// comes from the standard OTEL_* variables.
import { createRequire } from "node:module";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import * as sdkMetrics from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { loadModule, normalizeSync } from "libpg-query";

/** Paths the kubelet polls. They'd be nearly every span and request metric. */
const PROBE_PATHS = new Set(["/healthz"]);

/**
 * `sql` with every literal replaced by `$1`, `$2`, and so on, as pg_stat_statements shows it, so a
 * span never holds a value typed into the SQL view or an agent's query. SQL that doesn't parse
 * comes back blank; Postgres rejects it anyway.
 */
function normalized(sql: string): string {
  try {
    return normalizeSync(sql);
  } catch {
    return "";
  }
}

/**
 * Inbound HTTP with probes left out of spans and metrics and every query string dropped; outbound
 * fetch; Postgres queries with normalized SQL and no bound values; and the Node runtime's metrics
 * (event loop, heap, GC). Async because the SQL parser loads its WebAssembly first.
 */
export async function instrumentations(): Promise<
  [HttpInstrumentation, UndiciInstrumentation, PgInstrumentation, RuntimeNodeInstrumentation]
> {
  await loadModule();

  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        PROBE_PATHS.has(new URL(request.url ?? "/", "http://localhost").pathname),
      // The explorer's URL holds the query, so no span keeps a query string.
      requestHook: (span) => {
        span.setAttribute("url.query", "");
      },
      // airway's outbound requests use fetch, which the undici instrumentation covers.
      disableOutgoingRequestInstrumentation: true,
    }),
    // fetch, such as the JWKS fetch behind token checks.
    new UndiciInstrumentation(),
    new PgInstrumentation({
      // Runs after the instrumentation sets db.query.text, so this replaces it.
      requestHook: (span, { query }) => {
        span.setAttribute("db.query.text", normalized(query.text));
      },
    }),
    new RuntimeNodeInstrumentation(),
  ];
}

if ((process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "") !== "") {
  await startSdk();
}

async function startSdk(): Promise<void> {
  // airway logs to stdout, not over OTLP.
  process.env["OTEL_LOGS_EXPORTER"] ??= "none";
  // Every trace starts at airway: a traceparent header from the internet isn't trusted.
  process.env["OTEL_PROPAGATORS"] ??= "none";
  const started = new NodeSDK({
    serviceName: "airway",
    // Exponential histograms adapt their buckets to what's recorded, so no instrument picks bucket
    // boundaries.
    views: [
      {
        instrumentType: sdkMetrics.InstrumentType.HISTOGRAM,
        aggregation: { type: sdkMetrics.AggregationType.EXPONENTIAL_HISTOGRAM },
      },
    ],
    instrumentations: await instrumentations(),
  });
  started.start();
  // The instrumentations patch node:http and pg when something requires them. The bundle imports
  // them as ESM, which require hooks never see, so require them here.
  const require = createRequire(import.meta.url);
  require("node:http");
  require("pg");
  // The exporters' timers don't hold the process open, so the event loop empties once main.ts has
  // closed everything else. That's when to flush: every span has ended by then.
  process.once("beforeExit", () => {
    void started.shutdown();
  });
}
