import { defineConfig } from "oxlint";
import presets from "./oxlint.presets.ts";
import { WEB_RULES } from "./oxlint.web.ts";

type Brand = { name: string; owner: string };
// Branded types are only as safe as their constructors; a cast elsewhere forges one.
// typescript/no-unsafe-type-assertion already rejects every cast to a brand, so the owner's
// constructor casts behind a disable comment that says why. This list is a second lock: a file
// that disables no-unsafe-type-assertion for another cast still can't forge a brand. Add an entry
// with each new brand.
const BRANDS: Brand[] = [];
// An object shape spelled out where a function's return type goes, including inside
// `Promise<…>`, arrays, and unions. A named type says what the result is and reads at a glance.
const INLINE_RETURN_TYPE = {
  selector:
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSDeclareFunction, TSEmptyBodyFunctionExpression, TSFunctionType, TSMethodSignature, TSPropertySignature > TSTypeAnnotation > TSFunctionType) > TSTypeAnnotation.returnType TSTypeLiteral:not(TSFunctionType > * > TSTypeAnnotation TSTypeLiteral)",
  message: "Name the return type: declare `type X = { … }` and return `X`.",
};
type Restriction = { selector: string; message: string };
type RestrictedSyntax = ["error", ...Restriction[]];
/**
 * The `no-restricted-syntax` rule for `file`: no inline return types, and no casts to a brand
 * `file` doesn't own. An override replaces this rule rather than merging it, so every block that
 * sets it must include both.
 */
const restrictedSyntax = (file?: string): RestrictedSyntax => [
  "error",
  INLINE_RETURN_TYPE,
  ...BRANDS.filter(({ owner }) => owner !== file).map(({ name, owner }) => ({
    selector: `TSAsExpression TSTypeReference[typeName.name='${name}']`,
    message: `Only ${owner} creates a ${name}.`,
  })),
];
const BRAND_OWNERS = [...new Set(BRANDS.map(({ owner }) => owner))];

export default defineConfig({
  extends: [presets],
  // Type-aware rules run on tsgolint, which reads each file's tsconfig.json with TypeScript 7.
  // Oxlint reports a suppression comment that no longer suppresses anything only when asked.
  options: { typeAware: true, reportUnusedDisableDirectives: "error" },
  ignorePatterns: ["dist/", "node_modules/"],
  // ESLint rules Oxlint doesn't implement natively, run unchanged.
  jsPlugins: ["@stylistic/eslint-plugin", { name: "eslint-js", specifier: "oxlint-plugin-eslint" }],
  rules: {
    // Types, not interfaces: they compose into discriminated unions.
    "typescript/consistent-type-definitions": ["error", "type"],
    "eslint-js/no-restricted-syntax": restrictedSyntax(),
    // Conditions are booleans: `if (count)` skips 0 and `if (name)` skips "", so compare explicitly.
    "typescript/strict-boolean-expressions": [
      "error",
      {
        allowString: false,
        allowNumber: false,
        allowNullableObject: false,
        allowNullableBoolean: false,
        allowNullableString: false,
        allowNullableNumber: false,
        allowAny: false,
      },
    ],
    // Declared functions state what they return; inline callbacks and typed expressions infer it.
    "typescript/explicit-function-return-type": [
      "error",
      {
        allowExpressions: true,
        allowHigherOrderFunctions: true,
        allowTypedFunctionExpressions: true,
        allowDirectConstAssertionInArrowFunctions: true,
      },
    ],
    // The `v` flag gives Unicode-aware matching and stricter class syntax.
    "require-unicode-regexp": ["error", { requireFlag: "v" }],
    // More than four parameters means they belong together in an object.
    "max-params": ["error", { max: 4 }],
    // Method shorthand in a type checks parameters bivariantly, even under `strict`.
    "typescript/method-signature-style": ["error", "property"],
    // A cast can claim anything; narrow, parse, or brand in the owning module instead.
    "typescript/no-unsafe-type-assertion": "error",
    // The default sort compares UTF-16 code units, which is wrong for numbers and most text.
    "typescript/require-array-sort-compare": ["error", { ignoreStringArrays: false }],
    // A `let` with no value is a variable in an unknown state; compute it with an expression.
    "init-declarations": ["error", "always"],
    // Same-name property reads destructure; renamed ones (`const e = result.data`) may not.
    "prefer-destructuring": [
      "error",
      { array: false, object: true },
      { enforceForRenamedProperties: false },
    ],
    // Awaiting every returned promise keeps the function in async stack traces.
    "typescript/return-await": ["error", "always"],
    // A function that returns a Promise is `async`, so it can't also throw synchronously.
    "typescript/promise-function-async": "error",
    // A switch over a union handles every member, so adding a member fails to compile.
    "typescript/switch-exhaustiveness-check": "error",
    curly: ["error", "all"],
    // A blank line after every block and before every return or throw.
    "@stylistic/padding-line-between-statements": [
      "error",
      { blankLine: "always", prev: "block-like", next: "*" },
      { blankLine: "always", prev: "*", next: ["return", "throw"] },
    ],
    // Settings come from one parsed, validated place, so nothing else reads the environment.
    "eslint-js/no-restricted-properties": [
      "error",
      {
        object: "process",
        property: "env",
        message: "Read settings from the config (packages/server/src/config.ts).",
      },
    ],
  },
  overrides: [
    {
      files: ["packages/server/src/config.ts", "packages/testing/**", "scripts/**"],
      rules: { "eslint-js/no-restricted-properties": "off" },
    },
    {
      files: ["packages/web/**/*.{ts,tsx}"],
      plugins: ["react", "jsx-a11y"],
      rules: WEB_RULES,
    },
    // A brand's owner is exempt from this list for its own brands; its cast still needs the
    // no-unsafe-type-assertion disable comment.
    ...BRAND_OWNERS.map((file) => ({
      files: [file],
      rules: { "eslint-js/no-restricted-syntax": restrictedSyntax(file) },
    })),
    // Vitest reads a fixture's dependencies from its destructured first parameter, so a fixture
    // with none must still destructure `{}`. @airway/testing defines fixtures outside tests/.
    {
      files: ["tests/**/*.ts", "packages/*/tests/**/*.{ts,tsx}", "packages/testing/src/**/*.ts"],
      rules: { "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }] },
    },
  ],
});
