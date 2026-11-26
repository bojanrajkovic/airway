import type { Author, Channel } from "@airway/contract/author";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../runtime/context.ts";
import { identifier } from "./identity.ts";

/** Declares the Hono variables that `requireAuthor` sets for the routes behind it. */
export type AuthorEnv = { Variables: { author: Author } };

/**
 * Sets `c.var.author` and calls the next handler when identification succeeds. Otherwise responds
 * with `{ error: kind }` and status 503 for `provider_unavailable`, or 403 for any other failure.
 */
export function requireAuthor(ctx: AppContext, channel: Channel): MiddlewareHandler<AuthorEnv> {
  const identify = identifier(ctx);

  return async (c, next) => {
    const result = await identify(c.req.raw.headers, channel);
    if (result.isErr()) {
      const { kind } = result.error;

      return c.json({ error: kind }, kind === "provider_unavailable" ? 503 : 403);
    }

    c.set("author", result.value);
    await next();

    return undefined;
  };
}
