import { defineConfig } from "oxlint";
import presets from "./oxlint.presets.ts";
import { WEB_RULES } from "./oxlint.web.ts";

type Brand = { name: string; owner: string };
// Only a brand's owner file may cast to the brand. no-unsafe-type-assertion flags every cast, but
// a file can disable it for one line. `restrictedSyntax` uses this list to flag a cast to a brand
// in any file other than the brand's owner, even where no-unsafe-type-assertion is disabled. Add
// an entry for each new brand.
const BRANDS: Brand[] = [{ name: "TrustedSql", owner: "packages/contract/src/registry/define.ts" }];
// Matches an object type literal used as a function's return type, including inside
// `Promise<…>`, arrays, and unions. A named return type is easier to read.
const INLINE_RETURN_TYPE = {
  selector:
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSDeclareFunction, TSEmptyBodyFunctionExpression, TSFunctionType, TSMethodSignature, TSPropertySignature > TSTypeAnnotation > TSFunctionType) > TSTypeAnnotation.returnType TSTypeLiteral:not(TSFunctionType > * > TSTypeAnnotation TSTypeLiteral)",
  message: "Name the return type: declare `type X = { … }` and return `X`.",
};
type Restriction = { selector: string; message: string };
type RestrictedSyntax = ["error", ...Restriction[]];
/**
 * Returns the `no-restricted-syntax` options for `file`. The options ban inline return types and
 * casts to brands that `file` doesn't own. An override's options replace the base options, so
 * each override must include both restrictions.
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
  // Oxlint reports unused disable comments only when this option is on.
  options: { typeAware: true, reportUnusedDisableDirectives: "error" },
  ignorePatterns: ["dist/", "node_modules/"],
  // These plugins run the original ESLint rules that Oxlint doesn't implement natively.
  jsPlugins: ["@stylistic/eslint-plugin", { name: "eslint-js", specifier: "oxlint-plugin-eslint" }],
  rules: {
    // Use `type` for object shapes, because types compose into discriminated unions.
    "typescript/consistent-type-definitions": ["error", "type"],
    "eslint-js/no-restricted-syntax": restrictedSyntax(),
    // Require boolean conditions, because `if (count)` skips 0 and `if (name)` skips "".
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
    // Require return types on declared functions. Callbacks and typed expressions can infer them.
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
    // A function with more than four parameters takes them as one object.
    "max-params": ["error", { max: 4 }],
    // Method shorthand in a type checks parameters bivariantly, even under `strict`.
    "typescript/method-signature-style": ["error", "property"],
    // A cast skips type checking. Narrow, parse, or call the brand's constructor instead.
    "typescript/no-unsafe-type-assertion": "error",
    // The default sort compares UTF-16 code units, which is wrong for numbers and most text.
    "typescript/require-array-sort-compare": ["error", { ignoreStringArrays: false }],
    // Require an initial value on every `let`. Compute it with an expression, such as a ternary, instead
    // of assigning it later.
    "init-declarations": ["error", "always"],
    // Destructure a property into a variable of the same name. `const e = result.data` is fine.
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
    // Put a blank line after every block and before every return or throw.
    "@stylistic/padding-line-between-statements": [
      "error",
      { blankLine: "always", prev: "block-like", next: "*" },
      { blankLine: "always", prev: "*", next: ["return", "throw"] },
    ],
  },
  overrides: [
    {
      files: ["packages/web/**/*.{ts,tsx}"],
      plugins: ["react", "jsx-a11y"],
      rules: WEB_RULES,
    },
    // Lets each owner file cast to its own brands.
    ...BRAND_OWNERS.map((file) => ({
      files: [file],
      rules: { "eslint-js/no-restricted-syntax": restrictedSyntax(file) },
    })),
    // Vitest reads a fixture's dependencies from its destructured first parameter, so every
    // fixture destructures that parameter, even as `{}`. The list includes packages/testing/src/
    // because @airway/testing defines fixtures there.
    {
      files: ["tests/**/*.ts", "packages/*/tests/**/*.{ts,tsx}", "packages/testing/src/**/*.ts"],
      rules: { "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }] },
    },
  ],
});
