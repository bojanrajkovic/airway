# Development

## Setup

You need [mise](https://mise.jdx.dev) and a container runtime, [Podman](https://podman.io) or Docker. `mise install` installs the Node and pnpm versions pinned in `mise.toml`. `pnpm install` installs everything else. pnpm refuses package versions less than a day old, and versions published with weaker trust evidence than an earlier one; `pnpm-workspace.yaml` says why.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | The server and Vite's dev server together, with settings from `.env.example` and your `.env` ([Configuration](configuration.md)) |
| `pnpm build` | Each package's `build`: the web app, into the server's `dist/public/`, and the server bundle |
| `pnpm check` | Runs `typecheck`, `lint`, `format:check`, and `test`, reporting every failure instead of stopping at the first |
| `pnpm typecheck` | Runs `tsc` on the root project, then each package's own `typecheck` script |
| `pnpm lint` | Oxlint, with type-aware rules |
| `pnpm format` / `format:check` | Oxfmt: rewrite files, or only report |
| `pnpm test` | The unit tests |
| `pnpm test:db` | The database tests; start Postgres first |
| `pnpm test:browser` | The browser tests, in Chromium ([Testing](testing.md#browser-tests)) |
| `pnpm test:image` | The image tests, against the image in `AIRWAY_IMAGE` ([Testing](testing.md#image-tests)) |
| `pnpm db:up` / `db:down` | Start or stop Postgres 18 in Podman or Docker |

## Workspace

airway is a pnpm workspace. Each package lives in `packages/<name>/`, is private, and carries the same version as every other package. A package exists once it has code; there are no empty placeholders.

Adding a package takes four things:

1. `package.json` with `"private": true`, the shared version, `"type": "module"`, and `"exports": { "./*": "./src/*.ts" }`. Other packages then import `@airway/<name>/<file>`, which resolves to `src/<file>.ts`.
2. `tsconfig.json` that includes only `src` and sets up the platform the package runs on. `tsconfig.base.json` extends `@tsconfig/strictest` and holds airway's module settings.

   | The package runs in | `extends` | Also set |
   |---|---|---|
   | The server, or only in tests | `["@tsconfig/node/tsconfig.json", "../../tsconfig.base.json"]` | |
   | The browser | `"../../tsconfig.base.json"` | `"lib": ["ESNext", "DOM", "DOM.Iterable"]`, `"types": []` |
   | Both | `"../../tsconfig.base.json"` | `"lib": ["ESNext"]`, `"types": []` |

   `@tsconfig/node` is a catalog alias for the current Node major's base, such as `npm:@tsconfig/node26`, so a Node upgrade changes one catalog line. A shared package with no Node or DOM types can't touch either platform by accident: `node:fs` or `window` fails to compile.
3. `src/` for the code.
4. `tests/` for its tests, mirroring `src/`, with a `tests/tsconfig.json` that extends `../tsconfig.json`, includes `.`, and sets `"types": ["node"]` if the package's own config doesn't. Tests get their own project because their helpers bring in Node's types, and in one shared project those types would reach `src` too. [Testing](testing.md) covers where tests go.
5. A `typecheck` script: `tsc --project . && tsc --project tests`. `pnpm typecheck` runs it in every package.

`@airway/testing` holds test helpers that more than one package uses. It never ships in the image. A package that uses it lists `"@airway/testing": "workspace:*"` in its `devDependencies`.

`@airway/synthetic` generates the synthetic CPAP data that tests and local development use ([Synthetic data](synthetic-data.md)). Like `@airway/testing`, only tests and scripts import it, so it never ships in the image.

## Dependencies

Every dependency's version lives once, in the `catalog` in `pnpm-workspace.yaml`. Each `package.json` says `"catalog:"` instead of a version. `catalogMode: strict` makes `pnpm add` go through the catalog. A version typed into a `package.json` by hand isn't caught, so review rejects it.

To add a dependency, run `pnpm add <name> --filter @airway/<package>`. pnpm adds it to the catalog with an exact version (`savePrefix: ""`) and points the package at it.

## Lint and format

Oxlint runs the rules, and tsgolint runs the type-aware ones with TypeScript 7, reading each file's nearest `tsconfig.json`. The config has two files:

- `oxlint.presets.ts` holds the rules of ESLint's recommended preset and typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` presets, translated for Oxlint, which has no presets of its own.
- `oxlint.config.ts` holds airway's own rules, each with a comment saying why.

A few house rules shape how code reads:

- Types, not interfaces, and named return types instead of inline object shapes.
- Conditions are real booleans: `if (count > 0)`, never `if (count)`.
- No casts that claim more than the compiler knows. Parse, narrow, or brand instead.
- Only the file that owns a branded type creates it. Its constructor casts behind a `typescript/no-unsafe-type-assertion` disable comment that says why. When you add a brand, add it to `BRANDS` in `oxlint.config.ts`, so no other file can forge one even with that comment.

Oxlint runs some rules through JavaScript plugins it marks as alpha. `tests/lint.test.ts` lints `tests/fixtures/lint/violations.ts`, which breaks a set of rules on purpose, including every rule that runs as an alpha plugin, and checks the exact count per rule.

Oxfmt formats TypeScript, JSON, and YAML at a width of 100. It skips Markdown.

## Pull requests

[AGENTS.md](../AGENTS.md#pull-requests) has the rules for pull requests.
