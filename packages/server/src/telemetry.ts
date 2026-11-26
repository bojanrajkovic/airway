// Runs service code in spans. docs/observability.md covers what goes on a span and what gets
// logged.
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { suppressTracing, W3CTraceContextPropagator } from "@opentelemetry/core";
import { Err, ResultAsync, type Result } from "neverthrow";

// The trace API returns a proxy, so a tracer created at module load works once the SDK starts.
const tracer = trace.getTracer("airway");

/** A service's error is one case of the service's error union, and `kind` names the case. */
export type Tagged = { kind: string };

/**
 * Runs `fn` in an active span named `name`, ends the span when `fn` returns, and returns `fn`'s
 * result. `fn` sets its own attributes on `span`.
 *
 * - When `fn` returns an `Err`, `inSpan` marks the span failed and sets `error.type` to the error's
 *   `kind`.
 * - When `fn` throws, `inSpan` marks the span failed, records the exception, sets `error.type` to
 *   the exception's class, and rethrows.
 */
export function inSpan<T, E extends Tagged>(
  name: string,
  fn: (span: Span) => Result<T, E>,
): Result<T, E>;
export function inSpan<T>(name: string, fn: (span: Span) => T): T;
export function inSpan<T>(name: string, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, (span) => {
    try {
      return finish(span, fn(span));
    } catch (error) {
      fail(span, error);
    }
  });
}

/** Runs `fn` in a span, as `inSpan` does, and ends the span when the `ResultAsync` settles. */
export function inSpanAsync<T, E extends Tagged>(
  name: string,
  fn: (span: Span) => ResultAsync<T, E>,
): ResultAsync<T, E> {
  return new ResultAsync(
    tracer.startActiveSpan(name, async (span) => {
      try {
        return finish(span, await fn(span));
      } catch (error) {
        fail(span, error);
      }
    }),
  );
}

// The overloads guarantee that any `Err` checked here wraps a `Tagged` error.
const isFailure = (value: unknown): value is Err<unknown, Tagged> => value instanceof Err;

function finish<T>(span: Span, value: T): T {
  if (isFailure(value)) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("error.type", value.error.kind);
  }

  span.end();

  return value;
}

/**
 * Records the error on `span` (class, message, and stack), marks the span failed, ends it, and
 * rethrows the error.
 */
function fail(span: Span, error: unknown): never {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute("error.type", error instanceof Error ? error.constructor.name : typeof error);
  span.end();

  throw error;
}

/** Runs `fn` with tracing off, to keep an idle poll's I/O out of the traces. */
export function untraced<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}

// OTEL_PROPAGATORS=none makes the global propagator a no-op, so `currentTraceparent` and
// `contextOf` use this propagator directly.
const propagator = new W3CTraceContextPropagator();

/** Returns the active trace context as a W3C `traceparent`, or null outside a trace. */
export function currentTraceparent(): string | null {
  const carrier: { traceparent?: string } = {};
  propagator.inject(context.active(), carrier, defaultTextMapSetter);

  return carrier.traceparent ?? null;
}

/**
 * Returns the trace context parsed from `traceparent`, or the active context when `traceparent` is
 * null.
 */
export function contextOf(traceparent: string | null): Context {
  return traceparent === null
    ? context.active()
    : propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
}

/**
 * Exports the spans that this thread has ended but not yet sent. A worker thread calls it after
 * each task. piscina terminates workers, and a terminated worker never emits `beforeExit`, the
 * event that flushes the main thread's SDK.
 */
export async function flushSpans(): Promise<void> {
  const provider = trace.getTracerProvider();
  // oxlint-disable-next-line typescript/no-deprecated -- the API has no other way to reach the SDK's provider
  const delegate = provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;

  if (isFlushable(delegate)) {
    await delegate.forceFlush();
  }
}

/**
 * Resolves to a tracer provider with `forceFlush`. The SDK's providers have it, and the API's no-op
 * provider doesn't.
 */
type Flushable = { forceFlush: () => Promise<void> };

const isFlushable = (value: object): value is Flushable =>
  "forceFlush" in value && typeof value.forceFlush === "function";
