import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "rolldown";
import { createRequire } from "node:module";
import { inMemoryTelemetry } from "@airway/testing/telemetry";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { hostname } from "node:os";
import { detectResources } from "@opentelemetry/resources";
import { bundle } from "../rolldown.config.ts";
import { instrumentations, resourceDetectors, serviceInstanceId } from "../src/instrument.ts";

const { spans } = inMemoryTelemetry({ instrumentations: await instrumentations() });

const server = http.createServer((_req, res) => res.end("ok"));
let origin = "";

// Runs after the helper's beforeAll starts the SDK.
beforeAll(async () => {
  // Like the preload, require node:http after the SDK starts so the instrumentation patches it.
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

describe("serviceInstanceId", () => {
  it("is the host name on the main thread", () => {
    expect(serviceInstanceId({ isMainThread: true, threadId: 0 })).toBe(hostname());
  });

  it("adds the thread's ID in a worker", () => {
    expect(serviceInstanceId({ isMainThread: false, threadId: 3 })).toBe(`${hostname()}/worker-3`);
  });
});

describe("resourceDetectors", () => {
  it("detects the host and leaves service.instance.id unset", () => {
    const { attributes } = detectResources({ detectors: resourceDetectors });

    expect(attributes["service.instance.id"]).toBeUndefined();
    expect(attributes["host.name"]).toBe(hostname());
  });
});

describe("the preload", () => {
  it("starts the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set", { timeout: 30_000 }, async () => {
    // Write the bundle under the package directory so Node resolves its dependencies from the
    // package's node_modules.
    const workers = join(import.meta.dirname, "../.test-workers");
    await mkdir(workers, { recursive: true });
    const dir = await mkdtemp(join(workers, "instrument-"));
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    await build(bundle("instrument", "src/instrument.ts", dir));

    const run = promisify(execFile)(
      process.execPath,
      ["--import", join(dir, "instrument.js"), "--eval", ""],
      { env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" } },
    );

    await expect(run).resolves.toMatchObject({ stderr: "" });
  });
});
