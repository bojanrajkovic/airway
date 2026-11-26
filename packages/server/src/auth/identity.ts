// Works out who a request is from. docs/auth.md describes each mode and every failure.
import type { Author, Channel } from "@airway/contract/author";
import { okAsync, type ResultAsync } from "neverthrow";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { pomeriumVerifier } from "./pomerium.ts";

/** Describes why identification failed. Only `provider_unavailable` is a server error. */
export type IdentityFailure = {
  kind:
    | "missing_identity"
    | "invalid_identity"
    | "expired"
    | "wrong_audience"
    | "wrong_issuer"
    | "provider_unavailable";
  cause?: unknown;
};

/** Contains the email and optional name that an identity provider verified for a request. */
export type Identity = { email: string; name?: string | undefined };

/**
 * Checks a request's headers with one provider, such as Pomerium, to find who sent the request.
 * Every verifier returns an identity, and `toAuthor` turns the identity into an author.
 */
export type Verifier = (
  headers: Headers,
  channel: Channel,
) => ResultAsync<Identity, IdentityFailure>;

/** Finds the author of a request from its headers. */
export type Identify = (headers: Headers, channel: Channel) => ResultAsync<Author, IdentityFailure>;

/**
 * Builds the author for an identity on a channel. Pomerium sends an empty name, or omits the name,
 * when the profile's name is unset. The author's name is then the email's local part, so an author
 * always has a name.
 */
export function toAuthor({ email, name = "" }: Identity, channel: Channel): Author {
  const [localPart = email] = email.split("@");

  return { email, name: name.trim() === "" ? localPart : name.trim(), channel };
}

/** Returns the verifier for the mode set in `config.auth`. */
function verifierFor(ctx: AppContext): Verifier {
  const { auth } = ctx.config;
  switch (auth.mode) {
    case "none": {
      return () => okAsync(auth.author);
    }

    case "pomerium": {
      return pomeriumVerifier(auth, ctx.clock);
    }
  }
}

/**
 * Builds the function that identifies this server's requests, using the verifier for
 * `config.auth`. The function runs each check in an `auth.identify` span, and logs a refusal at
 * warn with the failure's kind and cause.
 */
export function identifier(ctx: AppContext): Identify {
  const verify = verifierFor(ctx);
  const log = ctx.logger.child({ module: "auth" });

  return (headers, channel) =>
    inSpanAsync("auth.identify", (span) => {
      span.setAttributes({ "airway.channel": channel, "airway.auth.mode": ctx.config.auth.mode });

      return verify(headers, channel)
        .map((identity) => toAuthor(identity, channel))
        .mapErr((failure) => {
          // A jose claim error contains the token's decoded claims, such as email and name. Logging
          // them is intentional, for debugging.
          log.warn({ channel, kind: failure.kind, err: failure.cause }, "request refused");
          if (failure.cause instanceof Error) {
            span.recordException(failure.cause);
          }

          return failure;
        });
    });
}
