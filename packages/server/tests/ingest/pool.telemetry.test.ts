import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { context, trace } from "@opentelemetry/api";
import { beforeEach, describe, expect, it } from "vitest";
import { FileKind } from "@airway/contract/derived/values";
import { transformer } from "@airway/contract/transformer";
import { IngestMetrics } from "../../src/ingest/metrics.ts";
import { computeNight, encodeTask } from "../../src/ingest/night.ts";
import { handle } from "../../src/ingest/night-worker.ts";
import { currentTraceparent } from "../../src/telemetry.ts";
import {
  folderContext,
  nightTasks,
  synthesizedNights,
  writeFolder,
} from "../support/cpap-folder.ts";

const { spans, metricReader } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

const synthetic = synthesizedNights([], 1);
const [task] = nightTasks(synthetic);

if (task === undefined) {
  throw new Error("expected a synthetic night");
}

/** Resolves to one data point's attributes and value. */
type Point = { attributes: unknown; value: unknown };

// Returns each data point of the metric `name` since the last collect.
async function points(name: string): Promise<Point[]> {
  const { resourceMetrics } = await metricReader.collect();

  return resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints.map(({ attributes, value }) => ({ attributes, value })));
}

describe("the night worker", () => {
  it("runs ingest.compute as a child of the caller's span", async () => {
    const ctx = folderContext(await writeFolder(synthetic.files));
    const parent = trace.getTracer("test").startSpan("ingest.night");
    const traceparent = context.with(trace.setSpan(context.active(), parent), currentTraceparent);
    parent.end();

    await handle(
      { kind: "night", task: encodeTask(task), traceparent },
      { config: transformer.serialize(ctx.config) },
    );

    const compute = spans.getFinishedSpans().find(({ name }) => name === "ingest.compute");
    expect(compute?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(compute?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(compute?.attributes["airway.night"]).toBe(task.night.toString());
    expect(
      spans
        .getFinishedSpans()
        .filter(
          ({ parentSpanContext }) => parentSpanContext?.spanId === compute?.spanContext().spanId,
        )
        .map(({ name }) => name),
    ).toEqual(["ingest.segments", "ingest.events", "ingest.samples", "ingest.breaths"]);
  });
});

describe("IngestMetrics", () => {
  it("records a computed night's rows, files read, steps, queue wait, and duration", async () => {
    const ctx = folderContext(await writeFolder(synthetic.files));
    const night = (await computeNight(ctx, task))._unsafeUnwrap();
    await metricReader.collect();

    new IngestMetrics().succeeded(task, night, 30);
    const { resourceMetrics } = await metricReader.collect();
    const byName = new Map(
      resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .map((metric) => [metric.descriptor.name, metric.dataPoints]),
    );

    expect(byName.get("airway.ingest.rows")?.map(({ attributes }) => attributes)).toEqual(
      ["segments", "sessions", "events", "samples", "breaths"].map((table) => ({
        "airway.table": table,
      })),
    );
    expect(byName.get("airway.ingest.files_read")).toContainEqual(
      expect.objectContaining({
        attributes: { "airway.file.kind": "eve", "airway.file.checksum": "match", outcome: "ok" },
        value: task.eveFiles.length,
      }),
    );
    expect(byName.get("airway.ingest.step.duration")).toHaveLength(4);
    expect(byName.get("airway.ingest.queue.duration")).toHaveLength(1);
    expect(byName.get("airway.ingest.night.duration")?.[0]?.attributes).toEqual({ outcome: "ok" });
  });

  it("records a failed night's file and outcome", async () => {
    await metricReader.collect();

    const pld = task.files.find(({ kind }) => kind === FileKind.Pld);

    if (pld === undefined) {
      throw new Error("expected a PLD file");
    }

    new IngestMetrics().failed(task, { kind: "read_failed", path: pld.path, cause: null }, 2);

    expect(await points("airway.ingest.files_read")).toEqual([
      { attributes: { "airway.file.kind": "pld", outcome: "error" }, value: 1 },
    ]);
  });
});
