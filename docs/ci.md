# CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`.

| Job | What it runs |
|---|---|
| Lint and test | `pnpm audit signatures`, then `pnpm check` |
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

## The ruleset on main

`main` requires Check and PR title to pass. Branches don't have to be up to date, and admins can bypass it. The ruleset is managed in the homelab repo's Terraform, not here.
