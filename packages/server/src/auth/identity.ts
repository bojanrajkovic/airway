// Who a request is from. docs/auth.md describes each mode and every failure.
import type { Author, Channel } from "@airway/contract/author";
import { okAsync, type ResultAsync } from "neverthrow";
import type { AppContext } from "../runtime/context.ts";
import { inSpanAsync } from "../telemetry.ts";
import { pomeriumVerifier } from "./pomerium.ts";

/** Why a request has no author. Only `provider_unavailable` is the server's fault. */
export type IdentityFailure = {
  kind:
    | "missing_identity"
    | "invalid_identity"
    | "expired"
    | "wrong_audience"
    | "wrong_issuer"
    | "provider_unavailable";
  /** The error behind the failure, when there is one, for the log and the span. */
  cause?: unknown;
};

/** The person an identity provider vouches for. `name` is whatever the provider sent, if any. */
export type Identity = { email: string; name?: string | undefined };

/**
 * Checks a request's identity with one provider, such as Pomerium, from its headers. A verifier
 * only says who the request is from; turning that into an author is shared.
 */
export type Verifier = (
  headers: Headers,
  channel: Channel,
) => ResultAsync<Identity, IdentityFailure>;

/** Finds the author of a request from its headers. */
export type Identify = (headers: Headers, channel: Channel) => ResultAsync<Author, IdentityFailure>;

/**
 * The author for an identity on a channel. An empty or missing name, which Pomerium sends when the
 * profile has none, falls back to the email's local part, so an author always has a name.
 */
export function toAuthor({ email, name = "" }: Identity, channel: Channel): Author {
  const [localPart = email] = email.split("@");

  return { email, name: name.trim() === "" ? localPart : name.trim(), channel };
}

/** The verifier `config.auth` names. */
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
 * The way this server identifies requests, picked once from `config.auth`. Each request runs in an
 * `auth.identify` span, and a refusal is logged at warn with its kind and the error behind it.
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
          // A jose claim error carries the token's decoded claims, email and name included; they're
          // logged on purpose, to debug refusals. The raw token never is.
          log.warn({ channel, kind: failure.kind, err: failure.cause }, "request refused");
          if (failure.cause instanceof Error) {
            span.recordException(failure.cause);
          }

          return failure;
        });
    });
}
