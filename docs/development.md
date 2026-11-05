# Development

## Setup

You need [mise](https://mise.jdx.dev) and [Podman](https://podman.io). `mise install` installs the Node and pnpm versions pinned in `mise.toml`. `pnpm install` installs everything else.

pnpm refuses two kinds of package version, both set in `pnpm-workspace.yaml`:

- **Anything published less than a day ago** (`minimumReleaseAge`). Most malicious releases are caught and pulled within a day.
- **A version published with weaker trust evidence than an earlier one** (`trustPolicy: no-downgrade`), such as a release without provenance after releases that had it. That's the usual sign of a stolen publish token.

## Scripts

| Script | What it does |
|---|---|
| `pnpm check` | Runs `typecheck`, `lint`, `format:check`, and `test`, reporting every failure instead of stopping at the first |
| `pnpm typecheck` | Runs `tsc` on the root project and on each package's own `tsconfig.json` |
| `pnpm lint` | Oxlint, with type-aware rules |
| `pnpm format` / `format:check` | Oxfmt: rewrite files, or only report |
| `pnpm test` | The unit tests |
| `pnpm test:db` | The database tests; start Postgres first |
| `pnpm db:up` / `db:down` | Start or stop Postgres 18 in Podman |

## Workspace

airway is a pnpm workspace. Each package lives in `packages/<name>/`, is private, and carries the same version as every other package. A package exists once it has code; there are no empty placeholders.

Adding a package takes four things:

1. `package.json` with `"private": true`, the shared version, `"type": "module"`, and `"exports": { "./*": "./src/*.ts" }`. Other packages then import `@airway/<name>/<file>`, which resolves to `src/<file>.ts`.
2. `tsconfig.json` that extends `../../tsconfig.base.json`, includes `src` and `tests`, and sets `lib` and `types` for where the package runs:

   | The package runs in | `lib` | `types` |
   |---|---|---|
   | Both the browser and the server | `["ESNext"]` | `[]` |
   | The server, or only in tests | `["ESNext"]` | `["node"]` |
   | The browser | `["ESNext", "DOM", "DOM.Iterable"]` | `[]` |

   A shared package with no Node or DOM types can't touch either platform by accident: `node:fs` or `window` fails to compile. `pnpm typecheck` picks up every `packages/*/tsconfig.json` on its own.
3. `src/` for the code.
4. `tests/` for its tests, mirroring `src/`. [Testing](testing.md) covers where tests go.

`@airway/testing` holds test helpers that more than one package uses. It never ships in the image. A package that uses it lists `"@airway/testing": "workspace:*"` in its `devDependencies`.

## Dependencies

Every dependency's version lives once, in the `catalog` in `pnpm-workspace.yaml`. Each `package.json` says `"catalog:"` instead of a version. `catalogMode: strict` makes pnpm refuse a version that isn't in the catalog, so two packages can't drift apart.

To add a dependency, run `pnpm add <name> --filter @airway/<package>`. pnpm adds it to the catalog with an exact version (`savePrefix: ""`) and points the package at it.

## Lint and format

Oxlint runs the rules, and tsgolint runs the type-aware ones with TypeScript 7, reading each file's nearest `tsconfig.json`. The config has two files:

- `oxlint.presets.ts` holds the rules of ESLint's recommended preset and typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` presets, translated for Oxlint, which has no presets of its own. It also holds React's hook rules for `packages/web`.
- `oxlint.config.ts` holds airway's own rules, each with a comment saying why.

A few house rules shape how code reads:

- Types, not interfaces, and named return types instead of inline object shapes.
- Conditions are real booleans: `if (count > 0)`, never `if (count)`.
- No casts that claim more than the compiler knows. Parse, narrow, or brand instead.
- A branded type may be cast to only in the file that owns it. When you add a brand, add it to `BRANDS` in `oxlint.config.ts` and add a case to the lint fixture.

Oxlint runs some rules through JavaScript plugins it marks as alpha. `tests/lint.test.ts` lints `tests/fixtures/lint/violations.ts`, which breaks each rule on purpose, and checks the exact count per rule. When you add or change a rule, add a violation to the fixture and update the count.

Oxfmt formats TypeScript, JSON, and YAML at a width of 100. It skips Markdown.

## Pull requests

- One concern per PR.
- Titles follow [Conventional Commits](https://www.conventionalcommits.org). Add `!` when a change raises `derived_version` or migrates the notes schema, because data changes are always breaking.
- PRs merge by squash, and the squash commit's body is the PR body. Write the body as a commit message, and put test plans and screenshots in a PR comment.
- Public places get synthetic data only: the repo, issues, PR bodies and comments, test plans, and screenshots.

## Landing a stack

Stacks use `gh stack` v0.3.0. `gh pr merge` can't merge a stacked PR.

1. Run `gh stack sync`.
2. Wait for CI to pass on every unmerged PR in the stack.
3. Replace each PR body `gh stack` generated with a real one, because the squash commit takes its body from the PR.
4. Run `gh stack merge <pr> --yes --squash`. It merges that PR and every PR below it.
5. If PRs remain above it, run `gh stack rebase` and `gh stack push`, then wait for CI again.

A lane with a single PR lands with `gh pr merge --squash`.
