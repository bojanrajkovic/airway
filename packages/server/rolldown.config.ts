import { defineConfig } from "rolldown";
import pkg from "./package.json" with { type: "json" };

// Packages in `dependencies` stay external and load from the image's node_modules. Workspace
// packages are bundled, because the image ships no workspace.
const EXTERNAL = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@airway/"));

export default defineConfig({
  input: { main: "src/main.ts" },
  platform: "node",
  external: (id) => EXTERNAL.some((name) => id === name || id.startsWith(`${name}/`)),
  transform: { target: "node26" },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    // One file per entry; later subcommands such as `rebuild` share main.js.
    codeSplitting: false,
    sourcemap: true,
    // Stack traces need only the mappings; embedded sources would double the maps' size.
    sourcemapExcludeSources: true,
  },
});
