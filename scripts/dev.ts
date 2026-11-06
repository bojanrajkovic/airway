// `pnpm dev`: runs the server from source, restarting it when a file changes, and Vite's dev
// server, which serves the web app with hot reload and forwards API requests to the server.
// Settings come from .env.example, and from .env when it exists; later files win.
import { spawn, type ChildProcess } from "node:child_process";
import pretty from "pino-pretty";

const server = spawn(
  process.execPath,
  [
    "--env-file=.env.example",
    "--env-file-if-exists=.env",
    "--watch",
    "packages/server/src/main.ts",
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
// The server logs JSON, as in production; this prints it readably.
server.stdout.pipe(pretty({ colorize: true }));

const vite = spawn("node_modules/.bin/vite", { cwd: "packages/web", stdio: "inherit" });

const children: ChildProcess[] = [server, vite];

function stopAll(): void {
  for (const child of children) {
    child.kill("SIGTERM");
  }
}

// When either process exits, or on Ctrl-C, stop both, so neither is left running alone.
for (const child of children) {
  child.once("exit", stopAll);
}

process.once("SIGINT", stopAll);
process.once("SIGTERM", stopAll);
