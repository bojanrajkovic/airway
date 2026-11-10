// Span helpers for services. docs/observability.md covers what goes on a span and what gets logged.
import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { ResultAsync, type Result } from "neverthrow";

// The trace API hands out a proxy, so a tracer taken at module load follows the SDK once it starts.
const tracer = trace.getTracer("airway");

/** A service's error: one case of the service's error union, named by `kind`. */
export type Tagged = { kind: string };

/**
 * Runs `fn` in an active span named `name` and ends the span when `fn` returns. An `Err` marks the
 * span failed with its `kind` as `error.type`. A throw marks it failed, records the exception
 * with its class as `error.type`, and rethrows. Neither is logged here: the code that returns an `Err` logs it, and the HTTP app's
 * error handler logs throws. `fn` sets its own attributes on `span`.
 */
export function inSpan<T, E extends Tagged>(
  name: string,
  fn: (span: Span) => Result<T, E>,
): Result<T, E> {
  return tracer.startActiveSpan(name, (span) => {
    try {
      return finish(span, fn(span));
    } catch (error) {
      fail(span, error);
    }
  });
}

/** Like `inSpan`, for work that returns a `ResultAsync`: the span ends when it settles. */
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

function finish<T, E extends Tagged>(span: Span, result: Result<T, E>): Result<T, E> {
  if (result.isErr()) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("error.type", result.error.kind);
  }

  span.end();

  return result;
}

/** Records the error on `span` (class, message, and stack), marks it failed, ends it, and rethrows. */
function fail(span: Span, error: unknown): never {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute("error.type", error instanceof Error ? error.constructor.name : typeof error);
  span.end();

  throw error;
}

/** Runs `fn` with tracing off, so an idle poll's I/O records no spans. */
export function untraced<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}
