// The tRPC instance every router builds on. docs/server.md (tRPC) describes procedures and errors.
import { transformer } from "@airway/contract/transformer";
import { metrics, SpanStatusCode, trace, type Histogram } from "@opentelemetry/api";
import { initTRPC } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import type { TrpcContext } from "./context.ts";

const t = initTRPC.context<TrpcContext>().create({ transformer });

const tracer = trace.getTracer("airway");

// Created on first use, not at module load: the metrics API has no proxy, so an instrument taken
// before the SDK starts stays a no-op.
let callDuration: Histogram | undefined = undefined;

function recordDuration(seconds: number, attributes: Record<string, string>): void {
  callDuration ??= metrics.getMeter("airway/trpc").createHistogram("rpc.server.call.duration", {
    description: "How long each tRPC procedure took, by procedure and error type.",
    unit: "s",
  });
  callDuration.record(seconds, attributes);
}

/**
 * Runs each procedure in a span named `trpc.<path>` and records its duration. A failure records its
 * tRPC code as `error.type`; only a server-side code (a 5xx) marks the span as an error. Inputs are
 * never recorded: they hold queries and note text.
 */
const observed = t.middleware(async ({ path, type, ctx, next }) => {
  const started = performance.now();
  const attributes = { "rpc.system": "trpc", "rpc.method": path };

  return await tracer.startActiveSpan(`trpc.${path}`, async (span) => {
    span.setAttributes({ ...attributes, "trpc.type": type });

    const result = await next({ ctx: { log: ctx.log.child({ path }) } });

    const failed = result.ok ? {} : { "error.type": result.error.code };
    span.setAttributes(failed);
    if (!result.ok && getHTTPStatusCodeFromError(result.error) >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    span.end();
    recordDuration((performance.now() - started) / 1000, { ...attributes, ...failed });

    return result;
  });
});

export const { router } = t;

/** The base for every procedure: traced, measured, and logging under its path. */
export const procedure = t.procedure.use(observed);
