import { authorLabel } from "@airway/contract/author";
import { procedure, router } from "./init.ts";

export const appRouter = router({
  /** Answers with the caller's label, so a client can check the API and auth end to end. */
  ping: procedure.query(({ ctx }) => ({ author: authorLabel(ctx.author) })),
});

/**
 * Describes the API's shape for the web app's tRPC client. The web app imports it as a type, so
 * server code stays out of the web bundle.
 */
export type AppRouter = typeof appRouter;
