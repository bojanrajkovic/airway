import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createPools } from "./db/pools.ts";
import { createApp } from "./http/app.ts";
import { createLogger } from "./logger.ts";
import type { AppContext } from "./runtime/context.ts";

const result = loadConfig();

if (result.isErr()) {
  process.stderr.write(
    `airway: invalid configuration\n${result.error.map((p) => `  ${p}\n`).join("")}`,
  );
  process.exit(1);
}

const config = result.value;
const logger = createLogger(config.logLevel);

if (config.auth.mode === "none") {
  logger.warn("authentication is off: every request acts as the configured local author");
}

// Everything opened below registers its cleanup here, and shutdown closes it in reverse order: the
// listener stops taking requests before the pools close.
const resources = new AsyncDisposableStack();
const ctx: AppContext = {
  config,
  logger,
  clock: () => Temporal.Now.instant(),
  db: resources.use(createPools(config, logger)),
};

// The listener comes first, so the pod answers /healthz while later startup work runs.
const builtWebRoot = fileURLToPath(new URL("./public/", import.meta.url));
const webRoot = existsSync(builtWebRoot) ? builtWebRoot : undefined;

if (webRoot === undefined) {
  logger.info("no web build next to the server; serving the API only");
}

const server = serve(
  { fetch: createApp(ctx, { webRoot }).fetch, port: config.port },
  ({ port }) => {
    logger.info({ port }, "listening");
  },
);
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
