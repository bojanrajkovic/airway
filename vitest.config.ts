import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import type { BrowserCommand } from "vitest/node";

const UNIT = ["tests/**/*.test.ts", "packages/*/tests/**/*.test.{ts,tsx}"];
// Telemetry tests start an OpenTelemetry SDK, which registers process-wide providers.
const TELEMETRY = ["{tests,packages/*/tests}/**/*.telemetry.test.{ts,tsx}"];
// Database tests need Postgres, which `pnpm db:up` starts locally and CI runs as a service.
const DB = ["{tests,packages/*/tests}/**/*.db.test.{ts,tsx}"];
// Browser tests render components in Chromium, which Playwright installs locally and CI's
// Playwright image ships.
const BROWSER = ["{tests,packages/*/tests}/**/*.browser.test.{ts,tsx}"];

const setColorScheme: BrowserCommand<["light" | "dark"]> = async ({ page }, scheme) => {
  await page.emulateMedia({ colorScheme: scheme });
};

export default defineConfig({
  test: {
    // Files and the tests in them run in a random order, so a test that relies on another having
    // run first fails. A failing run prints its seed; `--sequence.seed=<seed>` replays that order.
    sequence: { shuffle: true },
    projects: [
      // Shares a module registry across files, which saves starting one per file. A test that
      // sets process-wide state, such as an OpenTelemetry SDK, needs a project with isolation on.
      {
        extends: true,
        test: {
          name: "unit",
          include: UNIT,
          exclude: [...configDefaults.exclude, ...TELEMETRY, ...DB, ...BROWSER],
          isolate: false,
        },
      },
      // Isolated, so one file's SDK never records another file's spans.
      { extends: true, test: { name: "telemetry", include: TELEMETRY } },
      { extends: true, test: { name: "db", include: DB } },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "browser",
          include: BROWSER,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            commands: { setColorScheme },
          },
        },
      },
    ],
  },
});
