import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { err, errAsync, ok, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it } from "vitest";
import { inSpan, inSpanAsync, untraced } from "../src/telemetry.ts";

const { spans } = inMemoryTelemetry();

beforeEach(() => {
  spans.reset();
});

/** The one span the test ended. */
function onlySpan(): ReadableSpan {
  const [span, ...rest] = spans.getFinishedSpans();
  if (span === undefined || rest.length > 0) {
    throw new Error(`expected one ended span, got ${String(spans.getFinishedSpans().length)}`);
  }

  return span;
}

/** The parent span ID of the first span to end, and the span ID of the second. */
function innerParentAndOuter(): [string | undefined, string | undefined] {
  const finished = spans.getFinishedSpans();
  expect(finished).toHaveLength(2);
  const [inner, outer] = finished;

  return [inner?.parentSpanContext?.spanId, outer?.spanContext().spanId];
}

class PoolExhausted extends Error {}

describe("inSpan", () => {
  it("passes an Ok through and leaves the span's status unset", () => {
    expect(inSpan("work", () => ok(42))._unsafeUnwrap()).toBe(42);

    const span = onlySpan();
    expect(span.name).toBe("work");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes["error.type"]).toBeUndefined();
  });

  it("passes an Err through and records its kind as error.type", () => {
    const result = inSpan("work", () => err({ kind: "not_found" as const }));

    expect(result._unsafeUnwrapErr()).toEqual({ kind: "not_found" });
    expect(onlySpan().status.code).toBe(SpanStatusCode.ERROR);
    expect(onlySpan().attributes["error.type"]).toBe("not_found");
  });

  it("records a thrown error's class, without its message, and rethrows it", () => {
    expect(() =>
      inSpan("work", () => {
        throw new PoolExhausted("secret value in the message");
      }),
    ).toThrow(PoolExhausted);

    const span = onlySpan();
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span.attributes["error.type"]).toBe("PoolExhausted");
    expect(span.events).toEqual([]);
  });

  it("makes its span the parent of spans started inside it", () => {
    inSpan("outer", () => ok(inSpan("inner", () => ok(1))));

    const [parent, outer] = innerParentAndOuter();
    expect(parent).toBe(outer);
  });
});

describe("inSpanAsync", () => {
  it("ends the span when the work settles, with the Ok passed through", async () => {
    const result = await inSpanAsync("work", () => okAsync("done"));

    expect(result._unsafeUnwrap()).toBe("done");
    expect(onlySpan().status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records an Err's kind as error.type", async () => {
    const result = await inSpanAsync("work", () => errAsync({ kind: "timeout" as const }));

    expect(result._unsafeUnwrapErr()).toEqual({ kind: "timeout" });
    expect(onlySpan().attributes["error.type"]).toBe("timeout");
  });

  it("records a rejection's class and rejects with it", async () => {
    await expect(
      inSpanAsync("work", () => {
        throw new PoolExhausted("secret");
      }),
    ).rejects.toBeInstanceOf(PoolExhausted);

    expect(onlySpan().attributes["error.type"]).toBe("PoolExhausted");
  });

  it("keeps its span active across awaits inside the work", async () => {
    await inSpanAsync("outer", () =>
      okAsync(undefined).andThen(() => inSpanAsync("inner", () => okAsync(1))),
    );

    const [parent, outer] = innerParentAndOuter();
    expect(parent).toBe(outer);
  });
});

describe("untraced", () => {
  it("records no spans for work inside it", () => {
    untraced(() => {
      trace.getTracer("test").startSpan("idle poll").end();
    });

    expect(spans.getFinishedSpans()).toEqual([]);
  });
});
