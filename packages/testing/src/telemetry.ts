// An OpenTelemetry SDK that records into memory, for tests that assert on spans or metrics. Such
// tests are named `*.telemetry.test.ts`, so they run in the `telemetry` project, one file at a time.
import * as metrics from "@opentelemetry/sdk-metrics";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import * as tracing from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll } from "vitest";

export type TestTelemetry = {
  /** Every ended span. Call `reset()` to drop what earlier tests recorded. */
  spans: tracing.InMemorySpanExporter;
  /** Exports only on `collect()` or shutdown, because its interval is longer than any test. */
  metricReader: metrics.PeriodicExportingMetricReader;
  /** What `metricReader` exported. */
  metricExporter: metrics.InMemoryMetricExporter;
};

/**
 * Starts an SDK before the file's tests and shuts it down after them. Call it at the top level of
 * a test file. It samples every span, uses no resource detectors (so tests don't read the host),
 * and records delta metrics, so each `collect()` holds only what was recorded since the last one.
 */
export function inMemoryTelemetry({
  instrumentations = [],
}: Partial<Pick<NodeSDKConfiguration, "instrumentations">> = {}): TestTelemetry {
  const spans = new tracing.InMemorySpanExporter();
  const metricExporter = new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.DELTA);
  const metricReader = new metrics.PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const sdk = new NodeSDK({
    spanProcessors: [new tracing.SimpleSpanProcessor({ exporter: spans })],
    // An in-memory reader, or the SDK would start an OTLP exporter and wait for it at shutdown.
    metricReaders: [metricReader],
    instrumentations,
    resourceDetectors: [],
  });

  beforeAll(() => {
    sdk.start();
  });
  afterAll(async () => {
    await sdk.shutdown();
  });

  return { spans, metricReader, metricExporter };
}
