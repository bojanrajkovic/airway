import type { Author } from "@airway/contract/author";
import type { Context } from "hono";
import type { AuthorEnv } from "../auth/middleware.ts";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";

/** tRPC passes this to every procedure as `ctx`. */
export type TrpcContext = {
  app: AppContext;
  /** requireAuthor sets this to the caller before tRPC runs. */
  author: Author;
  /** Aborts when the client goes away, so long queries can stop. */
  signal: AbortSignal;
  /** The base procedure binds the procedure's path to this logger. */
  log: Logger;
};

/** Builds the tRPC context for a Hono request that requireAuthor has authenticated. */
export function createContext(app: AppContext, c: Context<AuthorEnv>): TrpcContext {
  return {
    app,
    author: c.var.author,
    signal: c.req.raw.signal,
    log: app.logger.child({ module: "trpc" }),
  };
}
