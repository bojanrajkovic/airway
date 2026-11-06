import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

const OXLINT = path.resolve("node_modules/oxlint/bin/oxlint");
// One fixture per rule set: the TypeScript house rules, and the React rules for packages/web.
const FIXTURES = [
  "tests/fixtures/lint/violations.ts",
  "packages/web/tests/fixtures/lint/violations.tsx",
];

const Report = z.object({ diagnostics: z.array(z.object({ code: z.string() })) });

// Oxlint runs the return-type and brand rules, and @stylistic, as JS plugins, which it marks alpha.
// A release that stopped one of them reporting would still pass `pnpm lint`, so this pins what the
// fixture's deliberate violations produce.
it("reports each violation in the lint fixtures", () => {
  const run = spawnSync(process.execPath, [OXLINT, "--format", "json", ...FIXTURES], {
    encoding: "utf8",
  });
  const { diagnostics } = Report.parse(JSON.parse(run.stdout));

  const counts = Object.fromEntries(
    Object.entries(Object.groupBy(diagnostics, ({ code }) => code)).map(([code, found]) => [
      code,
      found?.length,
    ]),
  );
  expect(counts).toEqual({
    "@stylistic(padding-line-between-statements)": 3,
    "eslint(curly)": 1,
    "eslint(init-declarations)": 1,
    "eslint(max-params)": 1,
    "eslint(no-unused-vars)": 3,
    "eslint(prefer-const)": 1,
    "eslint(prefer-destructuring)": 1,
    "eslint(require-unicode-regexp)": 1,
    "jsx-a11y(alt-text)": 1,
    "react(exhaustive-effect-dependencies)": 1,
    "react(hook-use-state)": 1,
    "react(hooks)": 1,
    "react(no-multi-comp)": 3,
    "react(purity)": 1,
    "react-hooks(exhaustive-deps)": 1,
    "react-hooks(rules-of-hooks)": 1,
    "eslint-js(no-restricted-syntax)": 1,
    "typescript(consistent-type-definitions)": 1,
    "typescript(explicit-function-return-type)": 1,
    "typescript(method-signature-style)": 1,
    "typescript(no-floating-promises)": 1,
    "typescript(no-unnecessary-condition)": 1,
    "typescript(no-unsafe-type-assertion)": 2,
    "typescript(prefer-nullish-coalescing)": 1,
    "typescript(promise-function-async)": 1,
    "typescript(require-array-sort-compare)": 1,
    "typescript(return-await)": 1,
    "typescript(strict-boolean-expressions)": 3,
    "typescript(switch-exhaustiveness-check)": 1,
  });
});
