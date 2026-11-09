import { Writable } from "node:stream";
import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger, type Logger } from "../src/logger.ts";

inMemoryTelemetry();

describe("createLogger", () => {
  /** What one log call wrote, parsed. */
  function logLine(write: (log: Logger) => void): Record<string, unknown> {
    let line = "";
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        line += chunk.toString();
        done();
      },
    });
    write(createLogger("info", sink));

    return z.record(z.string(), z.unknown()).parse(JSON.parse(line));
  }

  it("adds the active span's trace and span IDs to each line", () => {
    trace.getTracer("test").startActiveSpan("work", (span) => {
      const line = logLine((log) => {
        log.info("inside");
      });
      expect(line["trace_id"]).toBe(span.spanContext().traceId);
      expect(line["span_id"]).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it("adds no IDs outside a span", () => {
    const line = logLine((log) => {
      log.info("outside");
    });

    expect(line).not.toHaveProperty("trace_id");
  });
});
