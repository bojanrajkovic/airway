import { defineConfig, type RolldownOptions } from "rolldown";
import pkg from "./package.json" with { type: "json" };

// Packages in `dependencies` stay external and load from the image's node_modules. Workspace
// packages are bundled, because the image ships no workspace.
const EXTERNAL = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@airway/"));

/** Bundles `entry` to dist/`name`.js as one standalone file. */
const bundle = (name: string, entry: string): RolldownOptions => ({
  input: { [name]: entry },
  platform: "node",
  external: (id) => EXTERNAL.some((name) => id === name || id.startsWith(`${name}/`)),
  transform: { target: "node26" },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    // One file per entry; later subcommands such as `rebuild` share main.js.
    codeSplitting: false,
  },
});

// The preload runs with `node --import ./dist/instrument.js dist/main.js`.
export default defineConfig([
  bundle("main", "src/main.ts"),
  bundle("instrument", "src/instrument.ts"),
]);
