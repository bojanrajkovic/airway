import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import pretty from "pino-pretty";
import { watch } from "rolldown";
import { defineConfig, type Plugin } from "vite";
import serverBundles from "../server/rolldown.config.ts";

// The server listens on 3000 in dev; serverPlugin starts it.
const SERVER = "http://127.0.0.1:3000";
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Runs only in `vite` dev mode. Builds the server with its own rolldown config, watches the
 * server's sources, and runs the compiled bundle the way the image does, restarting the bundle
 * after each rebuild. When a build fails, the plugin logs the error and leaves the running server
 * up. The server reads its settings from .env.example, and from .env when it exists. Values in
 * .env override .env.example.
 */
function serverPlugin(): Plugin {
  let server: ChildProcess | undefined = undefined;
  // Restarts run one at a time, so two quick rebuilds can't start two servers.
  let restarting = Promise.resolve();

  const exited = (child: ChildProcess): boolean =>
    child.exitCode !== null || child.signalCode !== null;

  /** Sends SIGTERM, and SIGKILL if the server hasn't exited after SHUTDOWN_TIMEOUT_MS. */
  async function stop(): Promise<void> {
    const running = server;

    if (running === undefined || exited(running)) {
      return;
    }

    const exit = once(running, "exit", { signal: AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS) });
    running.kill("SIGTERM");

    await exit.catch(async () => {
      if (!exited(running)) {
        const killed = once(running, "exit");
        running.kill("SIGKILL");
        await killed;
      }
    });
  }

  function start(): void {
    server = spawn(
      process.execPath,
      [
        "--env-file=.env.example",
        "--env-file-if-exists=.env",
        "--import=./packages/server/dist/instrument.js",
        "packages/server/dist/main.js",
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );
    // The server logs JSON, as in production; pino-pretty formats it for the terminal.
    server.stdout?.pipe(pretty({ colorize: true }));
  }

  return {
    name: "airway-server",
    apply: "serve",
    configureServer(vite) {
      const watcher = watch(serverBundles);
      let failed = false;

      watcher.on("event", async (event) => {
        if (event.code === "START") {
          failed = false;
        } else if (event.code === "BUNDLE_END") {
          await event.result.close();
        } else if (event.code === "ERROR") {
          failed = true;
          await event.result.close();
          vite.config.logger.error(`server build failed: ${event.error.message}`);
        } else if (event.code === "END" && !failed) {
          restarting = restarting.then(async () => {
            await stop();
            start();
          });
        }
      });

      vite.httpServer?.once("close", () => {
        void watcher.close();
        restarting = restarting.then(stop);
      });
    },
  };
}

export default defineConfig({
  // The React Compiler memoizes components and hooks at build time.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), serverPlugin()],
  // main.ts serves the web build from this folder, next to the server's bundle.
  build: { outDir: "../server/dist/public", emptyOutDir: true },
  server: {
    proxy: { "/healthz": SERVER, "/trpc": SERVER, "/mcp": SERVER },
  },
});
