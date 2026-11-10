import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { identifier, toAuthor } from "../../src/auth/identity.ts";
import { testContext } from "../support/context.ts";
import { MCP_HOST, testIssuer, UI_HOST } from "../support/tokens.ts";

const issuer = testIssuer();

describe("toAuthor", () => {
  it("uses the identity's name", () => {
    expect(toAuthor({ email: "sam@example.test", name: " Sam Rivera " }, "web")).toEqual({
      email: "sam@example.test",
      name: "Sam Rivera",
      channel: "web",
    });
  });

  it.each([undefined, "", "  "])("falls back to the email's local part for name %j", (name) => {
    expect(toAuthor({ email: "sam@example.test", name }, "mcp")).toEqual({
      email: "sam@example.test",
      name: "sam",
      channel: "mcp",
    });
  });
});

describe("identifier with auth off", () => {
  it("names the configured local person on the request's channel, with no headers", async () => {
    const identify = identifier(testContext());

    expect((await identify(new Headers(), "mcp"))._unsafeUnwrap()).toEqual({
      name: "Sam Rivera",
      email: "sam@example.test",
      channel: "mcp",
    });
  });
});

describe("identifier with Pomerium", () => {
  it("logs why a token was refused, with jose's error and without the token", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const now = Temporal.Instant.from("2026-01-15T12:00:00Z");
    const base = testContext({ clock: () => now, logger: pino(sink) });
    const identify = identifier({
      ...base,
      config: {
        ...base.config,
        auth: { mode: "pomerium", uiHost: UI_HOST, mcpHost: MCP_HOST, jwksUrl: issuer.jwksUrl() },
      },
    });
    const token = await issuer.mint(now, {
      host: UI_HOST,
      expiresAt: now.subtract({ seconds: 1 }),
    });

    const result = await identify(new Headers({ "X-Pomerium-Jwt-Assertion": token }), "web");

    expect(result._unsafeUnwrapErr().kind).toBe("expired");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"kind":"expired"');
    expect(lines[0]).toContain("ERR_JWT_EXPIRED");
    expect(lines[0]).not.toContain(token);
  });
});
