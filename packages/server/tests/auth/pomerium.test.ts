import { errors } from "jose";
import { describe, expect, it } from "vitest";
import { classify, pomeriumVerifier } from "../../src/auth/pomerium.ts";
import { MCP_HOST, testIssuer, UI_HOST } from "../support/tokens.ts";

const issuer = testIssuer();
const NOW = Temporal.Instant.from("2026-01-15T12:00:00Z");

describe("classify", () => {
  const claimFailure = (claim: string): errors.JWTClaimValidationFailed =>
    new errors.JWTClaimValidationFailed("unexpected claim", {}, claim, "check_failed");

  it.each<[string, unknown, string]>([
    ["an expired token", new errors.JWTExpired("expired", {}), "expired"],
    ["a wrong aud", claimFailure("aud"), "wrong_audience"],
    ["a wrong iss", claimFailure("iss"), "wrong_issuer"],
    ["a token used before nbf", claimFailure("nbf"), "invalid_identity"],
    ["a bad signature", new errors.JWSSignatureVerificationFailed(), "invalid_identity"],
    ["a disallowed alg", new errors.JOSEAlgNotAllowed("none"), "invalid_identity"],
    ["a malformed token", new errors.JWSInvalid("bad"), "invalid_identity"],
    ["a key the JWKS lacks", new errors.JWKSNoMatchingKey(), "invalid_identity"],
    ["a JWKS timeout", new errors.JWKSTimeout(), "provider_unavailable"],
    ["a JWKS that isn't valid", new errors.JWKSInvalid("bad"), "provider_unavailable"],
    ["a failed fetch", new TypeError("fetch failed"), "provider_unavailable"],
  ])("treats %s as %s", (_, error, kind) => {
    expect(classify(error)).toBe(kind);
  });
});

describe("pomeriumVerifier", () => {
  const verifier = (): ReturnType<typeof pomeriumVerifier> =>
    pomeriumVerifier(
      { mode: "pomerium", uiHost: UI_HOST, mcpHost: MCP_HOST, jwksUrl: issuer.jwksUrl() },
      () => NOW,
    );
  const withToken = (token: string): Headers => new Headers({ "X-Pomerium-Jwt-Assertion": token });

  it("returns the token's email and name", async () => {
    const result = await verifier()(withToken(await issuer.mint(NOW, { host: UI_HOST })), "web");

    expect(result._unsafeUnwrap()).toEqual({ email: "sam@example.test", name: "Sam Rivera" });
  });

  it("refuses a request with no token as missing its identity", async () => {
    const result = await verifier()(new Headers(), "web");

    expect(result._unsafeUnwrapErr()).toEqual({ kind: "missing_identity" });
  });

  it("keeps jose's error as the cause of a refusal", async () => {
    const token = await issuer.mint(NOW, {
      host: UI_HOST,
      expiresAt: NOW.subtract({ seconds: 1 }),
    });

    const failure = (await verifier()(withToken(token), "web"))._unsafeUnwrapErr();

    expect(failure.kind).toBe("expired");
    expect(failure.cause).toBeInstanceOf(errors.JWTExpired);
  });
});
