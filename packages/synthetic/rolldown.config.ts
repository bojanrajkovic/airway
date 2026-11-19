import { defineConfig } from "rolldown";
import pkg from "./package.json" with { type: "json" };

// npm packages load from node_modules; workspace packages are bundled in.
const EXTERNAL = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@airway/"));

// `pnpm synth` builds dist/cli.js, then runs it.
export default defineConfig({
  input: { cli: "src/cli.ts" },
  platform: "node",
  external: (id) => EXTERNAL.some((name) => id === name || id.startsWith(`${name}/`)),
  transform: { target: "node26" },
  output: { dir: "dist", format: "esm", entryFileNames: "[name].js" },
});
