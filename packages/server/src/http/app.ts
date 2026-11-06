import { CSP } from "@airway/contract/csp";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { AppContext } from "../runtime/context.ts";

export type AppOptions = {
  /**
   * The web build's directory, next to the server bundle. Undefined when there's no build, as in
   * `pnpm dev`, where Vite serves the web app; the server then serves only the API.
   */
  webRoot: string | undefined;
};

/**
 * airway's HTTP app. Lanes mount their own sub-apps here with `app.route(path, routes(ctx))`,
 * before the deep-link fallback.
 */
export function createApp(ctx: AppContext, { webRoot }: AppOptions): Hono {
  const app = new Hono();
  const log = ctx.logger.child({ module: "http" });

  // After the handler, so 404s and errors carry the policy too.
  app.use(async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
  });
  app.onError((error, c) => {
    log.error({ err: error, method: c.req.method }, "request failed");

    return c.text("Internal Server Error", 500);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  if (webRoot !== undefined) {
    // Built assets have hashed names, so a missing one is a real 404, not a deep link.
    app.use("/assets/*", serveStatic({ root: webRoot }));
    app.get("/assets/*", async (c) => await c.notFound());
    // Any other GET is a client-side route: the web app reads the URL and renders the page. The
    // page is revalidated on every load, because a cached copy would point at assets a newer
    // build has replaced.
    app.get("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-cache");
    });
    app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
  }

  return app;
}
