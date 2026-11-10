import http from "node:http";
import { createRequire } from "node:module";
import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { instrumentations } from "../src/instrument.ts";

const { spans } = inMemoryTelemetry({ instrumentations: instrumentations() });

// Inbound patching is on the Server prototype, so a server created before the SDK starts is traced.
const server = http.createServer((_req, res) => res.end("ok"));
let origin = "";

// Runs after the helper's beforeAll starts the SDK.
beforeAll(async () => {
  // As the preload does: the instrumentation patches node:http when it's required after the start.
  createRequire(import.meta.url)("node:http");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server isn't listening on a TCP port");
  }

  origin = `http://127.0.0.1:${String(address.port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  spans.reset();
});

const serverSpans = (): ReadableSpan[] =>
  spans.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);

describe("inbound HTTP spans", () => {
  it("records no span for a probe", async () => {
    await fetch(`${origin}/healthz`);

    expect(serverSpans()).toEqual([]);
  });

  it("records a request without its query string", async () => {
    await fetch(`${origin}/explore?q=ahi%3E5`);

    const [span] = serverSpans();
    expect(span?.attributes["url.path"]).toBe("/explore");
    const text = Object.values(span?.attributes ?? {})
      .map(String)
      .join("\n");
    expect(text).not.toContain("ahi");
  });
});
