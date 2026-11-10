import { authorLabel } from "@airway/contract/author";
import { procedure, router } from "./init.ts";

export const appRouter = router({
  /** Answers with the caller's label, so a client can check the API and auth end to end. */
  ping: procedure.query(({ ctx }) => ({ author: authorLabel(ctx.author) })),
});

/** The API's shape, for the web app's tRPC client. A type only: the web bundle imports no server code. */
export type AppRouter = typeof appRouter;
