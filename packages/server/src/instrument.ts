// Loaded with `node --import` before the server, so instrumentation is registered before any
// dependency loads. The SDK starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set, and reads its
// other settings from the standard OTEL_* variables.
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { isMainThread, threadId } from "node:worker_threads";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  hostDetector,
  osDetector,
  processDetector,
  resourceAttributesEnvDetector,
  resourceFromAttributes,
  serviceNameEnvDetector,
  type ResourceDetector,
} from "@opentelemetry/resources";
import * as sdkMetrics from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { loadModule, normalizeSync } from "libpg-query";

/**
 * The HTTP instrumentation skips requests to these health check paths, which would otherwise make
 * up most spans and request metrics.
 */
const PROBE_PATHS = new Set(["/healthz"]);

/** Replaces each literal in `sql` with `$1`, `$2`, and so on. Returns "" for invalid SQL. */
function normalized(sql: string): string {
  try {
    return normalizeSync(sql);
  } catch {
    return "";
  }
}

/** Loads the SQL parser's WebAssembly module, then returns the instrumentations. */
export async function instrumentations(): Promise<
  [HttpInstrumentation, UndiciInstrumentation, PgInstrumentation, RuntimeNodeInstrumentation]
> {
  await loadModule();

  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        PROBE_PATHS.has(new URL(request.url ?? "/", "http://localhost").pathname),
      // Query strings are noisy and don't help debugging.
      requestHook: (span) => {
        span.setAttribute("url.query", "");
      },
      // airway's outbound requests use fetch, which the undici instrumentation covers.
      disableOutgoingRequestInstrumentation: true,
    }),
    // Traces fetch calls, such as the JWKS fetch behind token checks.
    new UndiciInstrumentation(),
    new PgInstrumentation({
      // The instrumentation sets db.query.text to the raw SQL before this hook runs.
      requestHook: (span, { query }) => {
        span.setAttribute("db.query.text", normalized(query.text));
      },
    }),
    new RuntimeNodeInstrumentation(),
  ];
}

/**
 * Returns this thread's `service.instance.id`: the host name, plus `/worker-<threadId>` in a worker
 * thread. Each worker loads this preload and exports its own telemetry, so the ID separates a worker's
 * runtime metrics from the main thread's.
 */
export function serviceInstanceId(thread = { isMainThread, threadId }): string {
  return thread.isMainThread ? hostname() : `${hostname()}/worker-${String(thread.threadId)}`;
}

/**
 * Lists NodeSDK's default resource detectors minus `serviceInstanceIdDetector`. That detector sets
 * `service.instance.id` to a random UUID. Detected attributes override the resource passed to
 * NodeSDK, so the UUID would replace `serviceInstanceId()`, and every restart would start new
 * series. The two env detectors read `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`.
 */
export const resourceDetectors: ResourceDetector[] = [
  processDetector,
  hostDetector,
  osDetector,
  resourceAttributesEnvDetector,
  serviceNameEnvDetector,
];

async function startSdk(): Promise<void> {
  // airway logs to stdout, not over OTLP.
  process.env["OTEL_LOGS_EXPORTER"] ??= "none";
  // airway ignores traceparent headers from the internet, so every trace starts at airway.
  process.env["OTEL_PROPAGATORS"] ??= "none";
  const started = new NodeSDK({
    serviceName: "airway",
    resourceDetectors,
    // The image sets both variables. A deployment's OTEL_RESOURCE_ATTRIBUTES overrides them.
    resource: resourceFromAttributes({
      "service.version": process.env["AIRWAY_VERSION"] ?? "dev",
      "vcs.ref.head.revision": process.env["AIRWAY_GIT_SHA"] ?? "dev",
      "service.instance.id": serviceInstanceId(),
    }),
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
  // closed everything else. Flush at that point, because every span has ended.
  process.once("beforeExit", () => {
    void started.shutdown();
  });
}

// Runs last, so startSdk reads module constants after they're initialized.
if ((process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "") !== "") {
  await startSdk();
}
