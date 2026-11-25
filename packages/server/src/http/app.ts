import { CSP } from "@airway/contract/csp";
import { serveStatic } from "@hono/node-server/serve-static";
import { trpcServer } from "@hono/trpc-server";
import { Hono, type Context } from "hono";
import { requireAuthor, type AuthorEnv } from "../auth/middleware.ts";
import type { AppContext } from "../runtime/context.ts";
import { createContext } from "../trpc/context.ts";
import { appRouter } from "../trpc/router.ts";

export type AppOptions = {
  /**
   * `webRoot` is the directory that holds the web build, next to the server bundle. It's undefined
   * when there's no web build. Under `pnpm dev`, for example, Vite serves the web app and the
   * server serves only the API.
   */
  webRoot: string | undefined;
};

/**
 * Builds airway's HTTP app. To add a module that serves HTTP, mount its sub-app here with
 * `app.route(path, routes(ctx))`, before the deep-link fallback.
 */
export function createApp(ctx: AppContext, { webRoot }: AppOptions): Hono {
  const app = new Hono();
  const log = ctx.logger.child({ module: "http" });

  // Sets the header after the handler runs, so 404 and error responses include the policy too.
  app.use(async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
  });
  app.onError((error, c) => {
    log.error({ err: error, method: c.req.method }, "request failed");

    return c.text("Internal Server Error", 500);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // requireAuthor is mounted here, rather than in each module, so it covers every route under these
  // paths.
  app.use("/trpc/*", requireAuthor(ctx, "web"));
  app.use("/mcp", requireAuthor(ctx, "mcp"));

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      endpoint: "/trpc",
      // Explorer queries can be long, so the client may send them as POST.
      allowMethodOverride: true,
      createContext: (_options, c: Context<AuthorEnv>) => createContext(ctx, c),
    }),
  );

  if (webRoot !== undefined) {
    // Built assets have hashed names, so a request for a missing asset returns 404 instead of the
    // web app's page.
    app.use("/assets/*", serveStatic({ root: webRoot }));
    app.get("/assets/*", async (c) => await c.notFound());
    // Any other GET is a client-side route and returns index.html. no-cache makes the browser
    // revalidate index.html, because a stale copy links to assets that a new build removed.
    app.get("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-cache");
    });
    app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
  }

  return app;
}
