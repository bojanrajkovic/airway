import { resolve } from "node:path";
import { defineConfig, type BuildOptions } from "rolldown";
import pkg from "./package.json" with { type: "json" };

// Packages in `dependencies` stay external and load from the image's node_modules. Workspace
// packages are bundled, because the image doesn't include the workspace.
const EXTERNAL = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@airway/"));

// Paths resolve from this file, so web's Vite plugin can build the server from another directory.
const here = (path: string): string => resolve(import.meta.dirname, path);

/** Bundles `entry` to `dir`/`name`.js as one standalone file. Tests build into their own `dir`. */
export const bundle = (name: string, entry: string, dir = here("dist")): BuildOptions => ({
  input: { [name]: here(entry) },
  platform: "node",
  external: (id) => EXTERNAL.some((name) => id === name || id.startsWith(`${name}/`)),
  transform: { target: "node26" },
  output: {
    dir,
    format: "esm",
    entryFileNames: "[name].js",
    // One file per entry; later subcommands such as `rebuild` share main.js.
    codeSplitting: false,
  },
});

// The preload runs with `node --import ./dist/instrument.js dist/main.js`. The night pool's workers
// load dist/night-worker.js and inherit the preload.
export default defineConfig([
  bundle("main", "src/main.ts"),
  bundle("instrument", "src/instrument.ts"),
  bundle("night-worker", "src/ingest/night-worker.ts"),
]);
