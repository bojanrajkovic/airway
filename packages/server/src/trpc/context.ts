import type { Author } from "@airway/contract/author";
import type { Context } from "hono";
import type { AuthorEnv } from "../auth/middleware.ts";
import type { Logger } from "../logger.ts";
import type { AppContext } from "../runtime/context.ts";

/** What every procedure gets as `ctx`. */
export type TrpcContext = {
  app: AppContext;
  /** Who called, set by requireAuthor before tRPC runs. */
  author: Author;
  /** Aborts when the client goes away, so long queries can stop. */
  signal: AbortSignal;
  /** Bound to the procedure's path by the base procedure. */
  log: Logger;
};

/** Builds a request's tRPC context from the Hono request requireAuthor already let through. */
export function createContext(app: AppContext, c: Context<AuthorEnv>): TrpcContext {
  return {
    app,
    author: c.var.author,
    signal: c.req.raw.signal,
    log: app.logger.child({ module: "trpc" }),
  };
}
