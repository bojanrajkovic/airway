# CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`.

| Job | What it runs |
|---|---|
| Lint and test | `pnpm audit signatures`, then `pnpm check`, then a check that every notes schema change has its migration ([Notes](notes.md#migrations)) |
| Database tests | `pnpm test:db`, with Postgres 18 as a service container |
| Browser tests | `pnpm test:browser` in Playwright's image, then uploads the screenshots |
| Image | Builds the image, runs `pnpm test:image` against it, and scans it with Grype |
| zizmor | Audits the workflows for security problems |
| Check | Fails unless every job above succeeded |

## The Check job

`main` requires Check. It exists because GitHub counts a job that was skipped after a job it needs failed as passing. Check always runs, and it fails if any job it gates failed, was cancelled, or was skipped. A new job joins the gate by being added to Check's `needs`.

## PR titles

`.github/workflows/pr-title.yml` checks that a PR's title is a [Conventional Commit](https://www.conventionalcommits.org), such as `feat(server): serve tRPC`. PRs merge by squash, so the title becomes the commit on `main` that Release Please reads. It runs again when the title changes.

## Supply chain

- Every action is pinned to a full commit SHA, with its version in a comment.
- zizmor audits the workflows with its auditor persona, which reports everything it finds. Its online audits also check each pinned action for impostor commits, known vulnerabilities, and refs that point somewhere unexpected. A finding fails the job and shows as an annotation on the PR.
- The workflow's token can only read the repo, and checkout doesn't keep the credentials around.
- `pnpm install --frozen-lockfile` installs exactly what the lockfile says, and `pnpm audit signatures` fails if a package's registry signature doesn't verify.
- Only pushes to `main` write caches (mise's tools, the pnpm store, and the image's layers). Pull requests only restore them.

## Renovate

[Renovate](https://docs.renovatebot.com) opens PRs for dependency updates, configured in `renovate.json`.

- Minor, patch, and digest updates merge on their own once CI passes. Majors wait for review.
- npm releases wait 3 days. pnpm's own `minimumReleaseAge` refuses anything less than a day old, so a younger version would fail the install.
- Packages that must move together share one PR: OpenTelemetry, Hono, Vite with Rolldown, Oxlint, the React packages, the Drizzle packages, pg with its types, and Node across `mise.toml`, the `Dockerfile`, and `@types/node`. The Playwright image moves with the playwright package, the Postgres image in `scripts/db.sh` moves with the one in `ci.yml`, and pnpm in the `Dockerfile` moves with `mise.toml`.
- Drizzle, pg, the MCP SDK, and ECharts never merge on their own, because each changes the SQL airway runs or what users and agents see. Node majors wait too: the distroless image's name holds the major, and Renovate can't rename it.
- Update PRs are titled `chore`, so they don't cut a release on their own. Security alerts and new distroless digests are titled `fix`, so they release and reach the deployment.

## The ruleset on main

`main` requires Check and PR title to pass. Branches don't have to be up to date, and admins can bypass it. The ruleset is managed in the homelab repo's Terraform, not here.
