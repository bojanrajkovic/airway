# Development

## Setup

You need [mise](https://mise.jdx.dev) and a container runtime, [Podman](https://podman.io) or Docker. `mise install` installs the Node and pnpm versions pinned in `mise.toml`. `pnpm install` installs everything else.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Vite's dev server for the web app. A Vite plugin builds the server with its rolldown config, runs the bundle with settings from `.env.example` and your `.env` ([Configuration](configuration.md)), and restarts it after each rebuild. A failed build leaves the last good server running |
| `pnpm build` | Runs each package's `build`, which builds the web app into the server's `dist/public/` and bundles the server |
| `pnpm check` | Runs `typecheck`, `lint`, `format:check`, and `test`, reporting every failure instead of stopping at the first |
| `pnpm typecheck` | Runs `tsc` on the root project, then each package's own `typecheck` script |
| `pnpm lint` | Oxlint, with type-aware rules |
| `pnpm format` / `format:check` | `format` rewrites files with Oxfmt, and `format:check` only reports the files it would change |
| `pnpm test` | The unit tests |
| `pnpm test:db` | The database tests; start Postgres first |
| `pnpm test:browser` | The browser tests, in Chromium ([Testing](testing.md#browser-tests)) |
| `pnpm test:image` | The image tests, against the image in `AIRWAY_IMAGE` ([Testing](testing.md#image-tests)) |
| `pnpm db:up` / `db:down` | Start or stop Postgres in Podman or Docker |
| `pnpm synth --out <dir>` | Write a synthetic CPAP data folder ([Synthetic data](synthetic-data.md#pnpm-synth)) |

`pnpm dev`, `pnpm synth`, and the image build compile TypeScript into bundles with rolldown, and Node runs only the bundles, so code can use any TypeScript syntax, including enums and parameter properties.

## Workspace

airway is a pnpm workspace. Each package lives in `packages/<name>/`, is private, and has the same version as every other package. Create a package only when you have code to put in it.

A new package needs:

1. `package.json` with `"private": true`, the shared version, `"type": "module"`, and `"exports": { "./*": "./src/*.ts" }`. Other packages then import `@airway/<name>/<file>`, which resolves to `src/<file>.ts`.
2. `tsconfig.json` that includes only `src` and sets up the platform the package runs on. `tsconfig.base.json` extends `@tsconfig/strictest` and holds airway's module settings.

   | The package runs in | `extends` | Also set |
   |---|---|---|
   | The server, or only in tests | `["@tsconfig/node/tsconfig.json", "../../tsconfig.base.json"]` | |
   | The browser | `"../../tsconfig.base.json"` | `"lib": ["ESNext", "DOM", "DOM.Iterable"]`, `"types": []` |
   | Both | `"../../tsconfig.base.json"` | `"lib": ["ESNext"]`, `"types": []` |

   `@tsconfig/node` is a catalog alias for the current Node major's base, such as `npm:@tsconfig/node26`, so a Node upgrade changes one catalog line. A shared package sets `"types": []` and leaves DOM out of `lib`, so code in it that uses `node:fs` or `window` fails to compile.
3. `src/` for the code.
4. `tests/` for its tests, mirroring `src/`, with a `tests/tsconfig.json` that extends `../tsconfig.json`, includes `.`, and sets `"types": ["node"]` if the package's own config doesn't. Tests have their own project because test helpers bring in Node's types, and a shared project would make those types available in `src` too. [Testing](testing.md) covers where tests go.
5. A `typecheck` script: `tsc --project . && tsc --project tests`. `pnpm typecheck` runs it in every package.

`@airway/testing` holds test helpers that more than one package uses. It never ships in the image. A package that uses it lists `"@airway/testing": "workspace:*"` in its `devDependencies`.

`@airway/edf` reads and writes the card's EDF files. It contains the AirSense signal list, `checkFileSize`, and the writer. It's separate from `@airway/contract` because only the server and the synthetic generator use it, and contract holds what the web app shares with the server.

`@airway/synthetic` generates the synthetic CPAP data that tests and local development use ([Synthetic data](synthetic-data.md)). Like `@airway/testing`, only tests and scripts import it, so it never ships in the image.

## Dependencies

Every dependency's version is written once, in the `catalog` in `pnpm-workspace.yaml`. Each `package.json` says `"catalog:"` instead of a version. `catalogMode: strict` makes `pnpm add` go through the catalog. Reviewers reject a version typed into a `package.json` by hand, because pnpm accepts it.

To add a dependency, run `pnpm add <name> --filter @airway/<package>`. pnpm adds it to the catalog with an exact version (`savePrefix: ""`) and points the package at it.

## Lint and format

Oxlint runs the rules, and tsgolint runs the type-aware ones with TypeScript 7, reading each file's nearest `tsconfig.json`. The config has two files:

- `oxlint.presets.ts` holds the rules of ESLint's recommended preset and typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` presets, translated for Oxlint, which has no presets of its own.
- `oxlint.config.ts` holds airway's own rules, each with a comment saying why.

airway's own rules include:

- Declare object shapes with `type` instead of `interface`, and name return types instead of writing inline object shapes.
- Conditions are real booleans: `if (count > 0)`, never `if (count)`.
- Don't cast a value to a type that the compiler can't verify. Parse, narrow, or brand the value instead.
- Only the file that owns a branded type creates it. Its constructor casts behind a `typescript/no-unsafe-type-assertion` disable comment that says why. When you add a brand, add it to `BRANDS` in `oxlint.config.ts`, so no other file can create the brand, even with that comment.

Oxlint runs some rules through JavaScript plugins it marks as alpha. `tests/fixtures/lint/violations.ts` breaks a set of rules on purpose, including every rule that runs as an alpha plugin. `tests/lint.test.ts` lints that file and checks the exact count of violations per rule.

Oxfmt formats TypeScript, JSON, and YAML at a width of 100. It skips Markdown.

## Pull requests

[AGENTS.md](../AGENTS.md#pull-requests) has the rules for pull requests.
