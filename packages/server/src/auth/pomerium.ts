// Identity from Pomerium's signed token. docs/auth.md describes what's checked and why.
import type { Channel } from "@airway/contract/author";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { AuthConfig } from "../config.ts";
import type { IdentityFailure, Verifier } from "./identity.ts";

/** The header Pomerium puts its signed identity token in. */
const TOKEN_HEADER = "X-Pomerium-Jwt-Assertion";

/**
 * The failure a jose error means. Token problems are the caller's; anything else, such as a JWKS
 * fetch that failed or timed out, is the key server's, so a valid token isn't turned away as bad.
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
 * Verifies the token in `X-Pomerium-Jwt-Assertion` against the JWKS at `jwksUrl`, fetched on first
 * use and cached. It must be ES256, unexpired at `clock()`, carry an email, and name the channel's
 * host as both `aud` and `iss`. Host and X-Forwarded-Host are never read.
 */
export function pomeriumVerifier(
  auth: Extract<AuthConfig, { mode: "pomerium" }>,
  clock: () => Temporal.Instant,
): Verifier {
  const jwks = createRemoteJWKSet(new URL(auth.jwksUrl));
  const hosts: Record<Channel, string> = { web: auth.uiHost, mcp: auth.mcpHost };

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
