import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The server listens on 3000 in dev; scripts/dev.ts starts both.
const SERVER = "http://127.0.0.1:3000";

export default defineConfig({
  // The React Compiler memoizes components and hooks at build time.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // Next to the server's bundle, where main.ts serves it from.
  build: { outDir: "../server/dist/public", emptyOutDir: true },
  server: {
    proxy: { "/healthz": SERVER, "/trpc": SERVER, "/mcp": SERVER },
  },
});
