// Stands in for Pomerium's token signing. It serves an ES256 key's JWKS over HTTP and signs tokens
// shaped like the ones Pomerium sends in X-Pomerium-Jwt-Assertion, with synthetic identities.
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll } from "vitest";

export const UI_HOST = "airway.example.test";
export const MCP_HOST = "airway-mcp.example.test";

export type MintOptions = {
  /** Sets the token's `aud` and `iss` to this host. */
  host: string;
  /** Sets the token's expiry. Defaults to five minutes after `now`. */
  expiresAt?: Temporal.Instant;
  /** Sign with a key the JWKS doesn't list. */
  foreignKey?: boolean;
  /** Leave the `name` claim empty, as Pomerium does when the profile has none. */
  noName?: boolean;
};

export type TestIssuer = {
  /** Returns the JWKS URL, which is valid once the file's tests start. */
  jwksUrl: () => string;
  /** Signs a token for Sam that's issued at `now`. */
  mint: (now: Temporal.Instant, options: MintOptions) => Promise<string>;
  /** Returns an `alg: none` token with the same claims as `mint`'s. */
  unsigned: (now: Temporal.Instant, host: string) => string;
};

/**
 * Serves a JWKS on a local port for the file's tests, and mints tokens signed with its key. Call
 * it at the top level of a test file.
 */
export function testIssuer(): TestIssuer {
  let keys: { signing: CryptoKey; foreign: CryptoKey } | undefined = undefined;
  let url = "";
  const server = http.createServer();

  beforeAll(async () => {
    const signing = await generateKeyPair("ES256");
    const foreign = await generateKeyPair("ES256");
    const jwks = { keys: [{ ...(await exportJWK(signing.publicKey)), kid: "test", alg: "ES256" }] };
    keys = { signing: signing.privateKey, foreign: foreign.privateKey };
    server.on("request", (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the JWKS server isn't listening on a TCP port");
    }

    url = `http://127.0.0.1:${String(address.port)}/jwks.json`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const claims = (noName = false): Record<string, string> => ({
    email: "sam@example.test",
    name: noName ? "" : "Sam Rivera",
  });

  return {
    jwksUrl: () => url,
    mint: async (now, { host, expiresAt, foreignKey = false, noName = false }) => {
      if (keys === undefined) {
        throw new Error("mint() was called before the issuer started; call it inside a test");
      }

      const issuedAt = Math.floor(now.epochMilliseconds / 1000);
      const expires = expiresAt ?? now.add({ minutes: 5 });

      return await new SignJWT(claims(noName))
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .setIssuer(host)
        .setAudience(host)
        .setSubject("sam-subject")
        .setJti(crypto.randomUUID())
        .setIssuedAt(issuedAt)
        .setExpirationTime(Math.floor(expires.epochMilliseconds / 1000))
        .sign(foreignKey ? keys.foreign : keys.signing);
    },
    unsigned: (now, host) =>
      new UnsecuredJWT(claims())
        .setIssuer(host)
        .setAudience(host)
        .setIssuedAt(Math.floor(now.epochMilliseconds / 1000))
        .setExpirationTime(Math.floor(now.add({ minutes: 5 }).epochMilliseconds / 1000))
        .encode(),
  };
}
