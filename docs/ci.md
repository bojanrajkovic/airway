# CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`.

| Job | What it runs |
|---|---|
| Lint and test | `pnpm audit signatures`, then `pnpm check` |
| Database tests | `pnpm test:db`, with Postgres 18 as a service container |
| Check | Fails unless both jobs above succeeded |

## The Check job

`main` requires one check: Check. It exists because GitHub counts a job that was skipped after a job it needs failed as passing. Check always runs, and it fails if any job it gates failed, was cancelled, or was skipped. A new job joins the gate by being added to Check's `needs`.

## Supply chain

- Every action is pinned to a full commit SHA, with its version in a comment.
- The workflow's token can only read the repo, and checkout doesn't keep the credentials around.
- `pnpm install --frozen-lockfile` installs exactly what the lockfile says, and `pnpm audit signatures` fails if a package's registry signature doesn't verify.
- Only pushes to `main` write caches (mise's tools and the pnpm store). Pull requests only restore them.

## The ruleset on main

`main` requires Check to pass. Branches don't have to be up to date, and admins can bypass it.
