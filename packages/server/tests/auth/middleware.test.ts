import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.ts";
import { testContext } from "../support/context.ts";
import { MCP_HOST, testIssuer, UI_HOST, type MintOptions } from "../support/tokens.ts";

const issuer = testIssuer();
const NOW = Temporal.Instant.from("2026-01-15T12:00:00Z");
const TOKEN_HEADER = "X-Pomerium-Jwt-Assertion";

let webRoot = "";

beforeAll(async () => {
  webRoot = await mkdtemp(path.join(tmpdir(), "airway-web-"));
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>airway</title>");
});
afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

/** The app with Pomerium checks on, against the test issuer's JWKS, or `jwksUrl` if given. */
function pomeriumApp(jwksUrl = issuer.jwksUrl()): ReturnType<typeof createApp> {
  const base = testContext({ clock: () => NOW });

  return createApp(
    {
      ...base,
      config: {
        ...base.config,
        auth: { mode: "pomerium", uiHost: UI_HOST, mcpHost: MCP_HOST, jwksUrl },
      },
    },
    { webRoot },
  );
}

const mint = async (options: MintOptions): Promise<string> => await issuer.mint(NOW, options);

describe("requireAuthor with Pomerium", () => {
  // A token for another host has the wrong iss and aud; jose checks iss first.
  it.each<[string, string, () => Promise<Record<string, string>>, string]>([
    ["no token", "/trpc/ping", async () => await Promise.resolve({}), "missing_identity"],
    [
      "a token from another key",
      "/trpc/ping",
      async () => ({ [TOKEN_HEADER]: await mint({ host: UI_HOST, foreignKey: true }) }),
      "invalid_identity",
    ],
    [
      "an alg none token",
      "/trpc/ping",
      async () => await Promise.resolve({ [TOKEN_HEADER]: issuer.unsigned(NOW, UI_HOST) }),
      "invalid_identity",
    ],
    [
      "an expired token",
      "/trpc/ping",
      async () => ({
        [TOKEN_HEADER]: await mint({ host: UI_HOST, expiresAt: NOW.subtract({ seconds: 1 }) }),
      }),
      "expired",
    ],
    [
      "a UI token",
      "/mcp",
      async () => ({ [TOKEN_HEADER]: await mint({ host: UI_HOST }) }),
      "wrong_issuer",
    ],
    [
      "an MCP token",
      "/trpc/ping",
      async () => ({ [TOKEN_HEADER]: await mint({ host: MCP_HOST }) }),
      "wrong_issuer",
    ],
    [
      "a token for a spoofed Host",
      "/trpc/ping",
      async () => ({
        Host: "evil.example.test",
        "X-Forwarded-Host": "evil.example.test",
        [TOKEN_HEADER]: await mint({ host: "evil.example.test" }),
      }),
      "wrong_issuer",
    ],
  ])("refuses %s on %s with a 403", async (_, url, headers, kind) => {
    const response = await pomeriumApp().request(url, { headers: await headers() });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: kind });
  });

  it("answers 503 when the JWKS can't be fetched, since the token may be fine", async () => {
    const app = pomeriumApp("http://127.0.0.1:9/jwks.json");

    const response = await app.request("/trpc/ping", {
      headers: { [TOKEN_HEADER]: await mint({ host: UI_HOST }) },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
  });

  it.each([
    ["/trpc/ping", UI_HOST],
    ["/mcp", MCP_HOST],
  ])("lets a valid token for its own host through on %s", async (url, host) => {
    const response = await pomeriumApp().request(url, {
      headers: { [TOKEN_HEADER]: await mint({ host }) },
    });

    // Nothing serves these paths yet, so passing the check means not being refused.
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(503);
  });

  it.each(["/healthz", "/explore"])("serves %s with no token", async (url) => {
    expect((await pomeriumApp().request(url)).status).toBe(200);
  });
});

describe("requireAuthor with auth off", () => {
  it("lets a request with no token through", async () => {
    const response = await createApp(testContext(), { webRoot }).request("/trpc/ping");

    expect(response.status).not.toBe(403);
  });
});
