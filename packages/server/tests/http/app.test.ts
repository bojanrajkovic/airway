import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CSP } from "@airway/contract/csp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { testContext } from "../support/context.ts";

let webRoot = "";

beforeAll(async () => {
  webRoot = await mkdtemp(path.join(tmpdir(), "airway-web-"));
  await mkdir(path.join(webRoot, "assets"));
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>airway</title>");
  await writeFile(path.join(webRoot, "assets", "app-abc123.js"), "export {};");
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

describe("createApp", () => {
  it.each([
    ["/explore", 200, "<!doctype html><title>airway</title>"],
    ["/s/abc123", 200, "<!doctype html><title>airway</title>"],
    ["/assets/app-abc123.js", 200, "export {};"],
    ["/assets/missing.js", 404, undefined],
    ["/healthz", 200, '{"status":"ok"}'],
  ])("GET %s answers %i with exactly one CSP header", async (url, status, body) => {
    const response = await createApp(testContext(), { webRoot }).request(url);

    expect(response.status).toBe(status);
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("cache-control")).toBe(
      url.startsWith("/assets/") || url === "/healthz" ? null : "no-cache",
    );

    if (body !== undefined) {
      expect(await response.text()).toBe(body);
    }
  });
});
