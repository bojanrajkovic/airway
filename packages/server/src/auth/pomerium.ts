// Reads a request's identity from Pomerium's signed token. docs/auth.md describes what the
// verifier checks and why.
import { Channel } from "@airway/contract/author";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AuthConfig } from "../config.ts";
import type { IdentityFailure, Verifier } from "./identity.ts";

/** Pomerium sends its signed identity token in this header. */
const TOKEN_HEADER = "X-Pomerium-Jwt-Assertion";

/**
 * Maps an error from jose to a kind of identity failure. A bad token is the caller's fault. Any
 * other error, such as a JWKS fetch that failed or timed out, is the key server's fault.
 * `classify` returns `provider_unavailable` for those errors, because the token may still be valid.
 */
export function classify(error: unknown): IdentityFailure["kind"] {
  if (error instanceof errors.JWTExpired) {
    return "expired";
  }

  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") {
      return "wrong_audience";
    }

    return error.claim === "iss" ? "wrong_issuer" : "invalid_identity";
  }

  const tokenProblem =
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys;

  return tokenProblem ? "invalid_identity" : "provider_unavailable";
}

const Claims = z.object({ email: z.email(), name: z.string().optional() });

/**
 * Verifies the token in `X-Pomerium-Jwt-Assertion` against the JWKS at `jwksUrl`. The jose library
 * fetches the JWKS on first use and caches it. The token must be signed with ES256, be unexpired at
 * `clock()`, contain an email, and name the channel's host as both `aud` and `iss`. The verifier
 * takes each channel's host from config and ignores the Host and X-Forwarded-Host headers.
 */
export function pomeriumVerifier(
  auth: Extract<AuthConfig, { mode: "pomerium" }>,
  clock: () => Temporal.Instant,
): Verifier {
  const jwks = createRemoteJWKSet(new URL(auth.jwksUrl));
  const hosts: Record<Channel, string> = {
    [Channel.Web]: auth.uiHost,
    [Channel.Mcp]: auth.mcpHost,
  };

  return (headers, channel) => {
    const token = headers.get(TOKEN_HEADER);
    if (token === null) {
      return errAsync({ kind: "missing_identity" });
    }

    return ResultAsync.fromPromise(
      jwtVerify(token, jwks, {
        algorithms: ["ES256"],
        audience: hosts[channel],
        issuer: hosts[channel],
        currentDate: new Date(clock().epochMilliseconds),
      }),
      (error): IdentityFailure => ({ kind: classify(error), cause: error }),
    ).andThen(({ payload }) => {
      const claims = Claims.safeParse(payload);

      return claims.success
        ? ok(claims.data)
        : err<never, IdentityFailure>({ kind: "invalid_identity" });
    });
  };
}
