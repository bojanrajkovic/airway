# airway

airway imports a ResMed CPAP's SD card into Postgres and serves a trends page, a query explorer, and an MCP server. Read [README.md](README.md) first, then the page in [docs/](docs/README.md) for the area you're changing.

## Public places get synthetic data only

This repo, its issues, PR bodies and comments, test plans, and screenshots are all public. Never put real CPAP data in any of them: no values or dates from real nights, no device serial numbers, no names or birth dates. Tests, fixtures, and screenshots use synthetic data. When a fix comes from looking at real data, describe the code change and leave the data out.

## Docs

`docs/` has one page per area, listed in [docs/README.md](docs/README.md). Each page describes how the code works now, not how it got there. Update the page in the same PR as the change. Don't add pages or subfolders: work runs in parallel stacks, and fixed pages keep them from colliding.

## Code layout

- Each workspace package lives in `packages/<name>/`, with its code in `src/` and its tests in `tests/`, mirroring `src/`.
- Test helpers that more than one package uses go in `@airway/testing`.
- Every dependency's version lives in the catalog in `pnpm-workspace.yaml`.
- Server code gets its config, logger, and clock from the `AppContext` it's given, never from `process.env` or globals. A lane that serves HTTP exports `routes(ctx): Hono` from its folder.
- A night is a `Temporal.PlainDate`.
- A function that can fail returns neverthrow's `Result` (or `ResultAsync`) instead of throwing.

[docs/development.md](docs/development.md) has the details, including how to add a package, and [docs/server.md](docs/server.md) covers the server's structure.

## Pull requests

- One concern per PR.
- Titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `build:`, and so on. Add `!` when a change raises `derived_version` or migrates the notes schema. Data changes are always breaking.
- PRs merge by squash, and the squash commit's body is the PR body, so write the body as a commit message. Test plans and screenshots go in a PR comment.
- Tests go where logic can be wrong: parsing, scoring, time math, the SQL path, permissions, and data writes. Trivial wiring gets none.
- `pnpm check` must pass, and so must `pnpm test:db` when database code changes. [docs/testing.md](docs/testing.md) explains both.
- Stacked PRs use `gh stack`, and land with `gh stack merge`, because `gh pr merge` can't merge them. Replace the PR bodies `gh stack` generates before merging.
