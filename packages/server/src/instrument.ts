// Loaded with `node --import` before the server, so instrumentation is registered before any
// dependency loads. It flushes on its own once the server has shut down. Without OTEL_EXPORTER_OTLP_ENDPOINT the SDK never starts: no exporters, no network
// calls. Everything else comes from the standard OTEL_* variables.
import { createRequire } from "node:module";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import * as sdkMetrics from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

/** Paths the kubelet polls. They'd be nearly every span and request metric. */
const PROBE_PATHS = new Set(["/healthz"]);

/**
 * Inbound HTTP with probes left out of spans and metrics and every query string dropped, and the
 * Node runtime's metrics (event loop, heap, GC).
 */
export function instrumentations(): [HttpInstrumentation, RuntimeNodeInstrumentation] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        PROBE_PATHS.has(new URL(request.url ?? "/", "http://localhost").pathname),
      // The explorer's URL holds the query, so no span keeps a query string.
      requestHook: (span) => {
        span.setAttribute("url.query", "");
      },
      // Outbound requests get their own instrumentation when airway makes any.
      disableOutgoingRequestInstrumentation: true,
    }),
    new RuntimeNodeInstrumentation(),
  ];
}

if ((process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "") !== "") {
  startSdk();
}

function startSdk(): void {
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
    instrumentations: instrumentations(),
  });
  started.start();
  // The instrumentation patches node:http when something requires it. The bundle imports it as
  // ESM, which require hooks never see, so require it here.
  createRequire(import.meta.url)("node:http");
  // The exporters' timers don't hold the process open, so the event loop empties once main.ts has
  // closed everything else. That's when to flush: every span has ended by then.
  process.once("beforeExit", () => {
    void started.shutdown();
  });
}
