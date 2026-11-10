import type { Author, Channel } from "@airway/contract/author";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../runtime/context.ts";
import { identifier } from "./identity.ts";

/** The header Pomerium puts its signed identity token in. */
const TOKEN_HEADER = "X-Pomerium-Jwt-Assertion";

/** Hono variables a route behind `requireAuthor` can read. */
export type AuthorEnv = { Variables: { author: Author } };

/**
 * Lets a request through only with an author, and sets it as `c.var.author`. A token problem is a
 * 403 and a JWKS that can't be fetched a 503; never a 401, which only Pomerium sends when a
 * session expires (docs/auth.md explains why). The body names the failure's kind.
 */
export function requireAuthor(ctx: AppContext, channel: Channel): MiddlewareHandler<AuthorEnv> {
  const identify = identifier(ctx);

  return async (c, next) => {
    const result = await identify(c.req.header(TOKEN_HEADER), channel);
    if (result.isErr()) {
      const { kind } = result.error;

      return c.json({ error: kind }, kind === "jwks_unavailable" ? 503 : 403);
    }

    c.set("author", result.value);
    await next();

    return undefined;
  };
}
