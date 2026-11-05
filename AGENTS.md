# airway

airway imports a ResMed AirSense 10's SD card into Postgres and serves a trends page, a query explorer, and an MCP server. Read [README.md](README.md) first, then the page in [docs/](docs/README.md) for the area you're changing.

## Public places get synthetic data only

This repo, its issues, PR bodies and comments, test plans, and screenshots are all public. Never put real CPAP data in any of them: no values or dates from real nights, no device serial numbers, no names or birth dates. Tests, fixtures, and screenshots use synthetic data. When a fix comes from looking at real data, describe the code change and leave the data out.

## Docs

`docs/` has one page per area, listed in [docs/README.md](docs/README.md). Each page describes how the code works now, not how it got there. Update the page in the same PR as the change. Don't add pages or subfolders: work runs in parallel stacks, and fixed pages keep them from colliding.

## Code layout

- Each workspace package lives in `packages/<name>/`, with its code in `src/` and its tests in `tests/`, mirroring `src/`.
- Test helpers that more than one package uses go in `@airway/testing`.
- Every dependency's version lives in the catalog in `pnpm-workspace.yaml`.

[docs/development.md](docs/development.md) has the details, including how to add a package.

## Pull requests

- One concern per PR.
- Titles follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `build:`, and so on. Add `!` when a change raises `derived_version` or migrates the notes schema. Data changes are always breaking.
- PRs merge by squash, and the squash commit's body is the PR body, so write the body as a commit message. Test plans and screenshots go in a PR comment.
- Tests go where logic can be wrong: parsing, scoring, time math, the SQL path, permissions, and data writes. Trivial wiring gets none.
- `pnpm check` must pass, and so must `pnpm test:db` when database code changes. [docs/testing.md](docs/testing.md) explains both.

## Landing a stack

Stacks use `gh stack` v0.3.0. `gh pr merge` can't merge a stacked PR.

1. Run `gh stack sync`.
2. Wait for CI to pass on every unmerged PR in the stack.
3. Replace each PR body `gh stack` generated with a real one, because the squash commit takes its body from the PR.
4. Run `gh stack merge <pr> --yes --squash`. It merges that PR and every PR below it.
5. If PRs remain above it, run `gh stack rebase` and `gh stack push`, then wait for CI again.

A lane with a single PR lands with `gh pr merge --squash`.
