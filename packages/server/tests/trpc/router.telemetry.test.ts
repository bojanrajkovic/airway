import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanStatusCode } from "@opentelemetry/api";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { procedure, router } from "../../src/trpc/init.ts";
import { testContext } from "../support/context.ts";

const { spans, metricReader } = inMemoryTelemetry();
const app = createApp(testContext(), { webRoot: undefined });

beforeEach(() => {
  spans.reset();
});

/** Every rpc.server.call.duration point recorded since the last collect, by its attributes. */
async function callDurations(): Promise<Record<string, unknown>[]> {
  const { resourceMetrics } = await metricReader.collect();

  return resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === "rpc.server.call.duration")
    .flatMap((metric) => metric.dataPoints.map((point) => point.attributes));
}

describe("procedure telemetry", () => {
  it("records a span and a duration for a successful call, without inputs", async () => {
    await callDurations();

    await app.request('/trpc/ping?input={"json":"secret"}');

    const [span] = spans.getFinishedSpans().filter((ended) => ended.name === "trpc.ping");
    expect(span?.attributes).toEqual({
      "rpc.system": "trpc",
      "rpc.method": "ping",
      "trpc.type": "query",
    });
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(await callDurations()).toEqual([{ "rpc.system": "trpc", "rpc.method": "ping" }]);
  });

  it.each([
    ["NOT_FOUND", SpanStatusCode.UNSET],
    ["INTERNAL_SERVER_ERROR", SpanStatusCode.ERROR],
  ] as const)(
    "records %s as error.type, and marks the span failed only for a server error",
    async (code, status) => {
      await callDurations();
      const failing = router({
        fail: procedure.query(() => {
          throw new TRPCError({ code });
        }),
      });
      const base = testContext();
      const caller = failing.createCaller({
        app: base,
        author: { email: "sam@example.test", name: "Sam", channel: "web" },
        signal: new AbortController().signal,
        log: base.logger,
      });

      await expect(caller.fail()).rejects.toThrow(TRPCError);

      const [span] = spans.getFinishedSpans().filter((ended) => ended.name === "trpc.fail");
      expect(span?.attributes["error.type"]).toBe(code);
      expect(span?.status.code).toBe(status);
      expect(await callDurations()).toEqual([
        { "rpc.system": "trpc", "rpc.method": "fail", "error.type": code },
      ]);
    },
  );
});
