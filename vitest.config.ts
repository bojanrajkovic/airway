import { defineConfig } from "vitest/config";

const UNIT = ["tests/**/*.test.ts", "packages/*/tests/**/*.test.{ts,tsx}"];

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
          isolate: false,
        },
      },
    ],
  },
});
