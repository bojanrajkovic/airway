import { errors } from "jose";
import { describe, expect, it } from "vitest";
import { authorFromClaims, classify, identifier } from "../../src/auth/identity.ts";
import { testContext } from "../support/context.ts";

describe("classify", () => {
  const claimFailure = (claim: string): errors.JWTClaimValidationFailed =>
    new errors.JWTClaimValidationFailed("unexpected claim", {}, claim, "check_failed");

  it.each<[string, unknown, string]>([
    ["an expired token", new errors.JWTExpired("expired", {}), "expired"],
    ["a wrong aud", claimFailure("aud"), "wrong_audience"],
    ["a wrong iss", claimFailure("iss"), "wrong_issuer"],
    ["a token used before nbf", claimFailure("nbf"), "invalid_token"],
    ["a bad signature", new errors.JWSSignatureVerificationFailed(), "invalid_token"],
    ["a disallowed alg", new errors.JOSEAlgNotAllowed("none"), "invalid_token"],
    ["a malformed token", new errors.JWSInvalid("bad"), "invalid_token"],
    ["a key the JWKS lacks", new errors.JWKSNoMatchingKey(), "invalid_token"],
    ["a JWKS timeout", new errors.JWKSTimeout(), "jwks_unavailable"],
    ["a JWKS that isn't valid", new errors.JWKSInvalid("bad"), "jwks_unavailable"],
    ["a failed fetch", new TypeError("fetch failed"), "jwks_unavailable"],
  ])("treats %s as %s", (_, error, kind) => {
    expect(classify(error)).toEqual({ kind });
  });
});

describe("authorFromClaims", () => {
  it("uses the token's name", () => {
    expect(
      authorFromClaims({ email: "sam@example.test", name: "Sam Rivera" }, "web")._unsafeUnwrap(),
    ).toEqual({ email: "sam@example.test", name: "Sam Rivera", channel: "web" });
  });

  it.each([undefined, "", "  "])("falls back to the email's local part for name %j", (name) => {
    expect(authorFromClaims({ email: "sam@example.test", name }, "mcp")._unsafeUnwrap()).toEqual({
      email: "sam@example.test",
      name: "sam",
      channel: "mcp",
    });
  });

  it("refuses a token with no email", () => {
    expect(authorFromClaims({ name: "Sam" }, "web")._unsafeUnwrapErr()).toEqual({
      kind: "invalid_token",
    });
  });
});

describe("identifier with auth off", () => {
  it("names the configured local person on the request's channel, with no token", async () => {
    const identify = identifier(testContext());

    expect((await identify(undefined, "mcp"))._unsafeUnwrap()).toEqual({
      name: "Sam Rivera",
      email: "sam@example.test",
      channel: "mcp",
    });
  });
});
