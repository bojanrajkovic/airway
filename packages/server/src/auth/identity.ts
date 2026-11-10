// Who a request is from. docs/auth.md describes both modes and every failure.
import type { Author, Channel } from "@airway/contract/author";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { z } from "zod";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";

/** Why a request has no author. Only `jwks_unavailable` is the server's fault. */
export type IdentityFailure = {
  kind:
    | "missing_token"
    | "invalid_token"
    | "expired"
    | "wrong_audience"
    | "wrong_issuer"
    | "jwks_unavailable";
  /** The jose or fetch error behind the failure, when there is one, for the log and the span. */
  cause?: unknown;
};

/** Finds the author of a request from its identity token, which is undefined when it has none. */
export type Identify = (
  token: string | undefined,
  channel: Channel,
) => ResultAsync<Author, IdentityFailure>;

/**
 * The failure a jose error means. Token problems are the caller's; anything else, such as a JWKS
 * fetch that failed or timed out, is the key server's, so a valid token isn't turned away as bad.
 */
export function classify(error: unknown): IdentityFailure {
  if (error instanceof errors.JWTExpired) {
    return { kind: "expired" };
  }

  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") {
      return { kind: "wrong_audience" };
    }

    return error.claim === "iss" ? { kind: "wrong_issuer" } : { kind: "invalid_token" };
  }

  const tokenProblem =
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys;

  return { kind: tokenProblem ? "invalid_token" : "jwks_unavailable" };
}

const Claims = z.object({ email: z.email(), name: z.string().optional() });

/**
 * The author a verified token names. An empty `name`, which Pomerium sends when the profile has
 * none, falls back to the email's local part, so an author always has a name.
 */
export function authorFromClaims(
  payload: JWTPayload,
  channel: Channel,
): Result<Author, IdentityFailure> {
  const claims = Claims.safeParse(payload);
  if (!claims.success) {
    return err({ kind: "invalid_token" });
  }

  const { email, name = "" } = claims.data;
  const [localPart = email] = email.split("@");

  return ok({ email, name: name.trim() === "" ? localPart : name.trim(), channel });
}

/**
 * The way this server identifies requests, picked once from `config.auth`. With `pomerium`, a
 * token is verified against the JWKS (fetched on first use and cached), must be ES256, and must
 * name the channel's host as both `aud` and `iss`. With `none`, every request is the local person.
 */
export function identifier(ctx: AppContext): Identify {
  const { auth } = ctx.config;
  if (auth.mode === "none") {
    return (_token, channel) => okAsync({ ...auth.author, channel });
  }

  const log = ctx.logger.child({ module: "auth" });
  const jwks = createRemoteJWKSet(new URL(auth.jwksUrl));
  const hosts: Record<Channel, string> = { web: auth.uiHost, mcp: auth.mcpHost };

  return (token, channel) =>
    inSpanAsync("auth.identify", (span) => {
      span.setAttribute("airway.channel", channel);

      const verified =
        token === undefined
          ? errAsync<Author, IdentityFailure>({ kind: "missing_token" })
          : ResultAsync.fromPromise(
              jwtVerify(token, jwks, {
                algorithms: ["ES256"],
                audience: hosts[channel],
                issuer: hosts[channel],
                currentDate: new Date(ctx.clock().epochMilliseconds),
              }),
              (error) => ({ ...classify(error), cause: error }),
            ).andThen(({ payload }) => authorFromClaims(payload, channel));

      return verified.mapErr((failure) => {
        // jose's messages name the claim or key that failed, never the token or its values.
        log.warn({ channel, kind: failure.kind, err: failure.cause }, "request refused");
        if (failure.cause instanceof Error) {
          span.recordException(failure.cause);
        }

        return failure;
      });
    });
}
