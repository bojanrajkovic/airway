import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { createLogger } from "./logger.ts";
import type { AppContext } from "./runtime/context.ts";

const result = loadConfig();

if (result.kind === "invalid") {
  process.stderr.write(
    `airway: invalid configuration\n${result.problems.map((p) => `  ${p}\n`).join("")}`,
  );
  process.exit(1);
}

const { config } = result;
const logger = createLogger(config.logLevel);
const ctx: AppContext = { config, logger, clock: () => Temporal.Now.instant() };
// Everything opened below registers its cleanup here, and shutdown closes it in reverse order.
const resources = new AsyncDisposableStack();

// The listener comes first, so the pod answers /healthz while later startup work runs.
const builtWebRoot = fileURLToPath(new URL("./public/", import.meta.url));
const webRoot = existsSync(builtWebRoot) ? builtWebRoot : undefined;

if (webRoot === undefined) {
  logger.info("no web build next to the server; serving the API only");
}

const server = serve({ fetch: createApp(ctx, { webRoot }).fetch, port: config.port });
resources.defer(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
});
logger.info({ port: config.port }, "listening");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "shutting down");

  try {
    await resources.disposeAsync();
  } catch (error) {
    logger.error({ err: error }, "shutdown failed");
    process.exitCode = 1;
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, (received) => {
    shutdown(received).catch(() => {
      process.exitCode = 1;
    });
  });
}
