# CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`.

| Job | What it runs |
|---|---|
| Lint and test | `pnpm audit signatures`, then `pnpm check`, then a check that every notes schema change has its migration ([Notes](notes.md#migrations)) |
| Database tests | `pnpm test:db`, with Postgres as a service container |
| Browser tests | Runs `pnpm test:browser` in Playwright's image, then uploads the screenshots |
| Image | Builds the image, runs `pnpm test:image` against it, and scans it with Grype |
| zizmor | Audits the workflows for security problems |
| Check | Fails unless every job above succeeded |

## Required checks

`main` requires Check and PR title to pass. A branch can merge while it's behind `main`.

## The Check job

Check exists because GitHub counts a skipped job as passing, and GitHub skips a job when a job that it needs fails. Check always runs, and it fails if any job that it needs failed, was cancelled, or was skipped. To make Check cover a new job, add the job to Check's `needs`.

## PR titles

`.github/workflows/pr-title.yml` checks that a PR's title is a [Conventional Commit](https://www.conventionalcommits.org), such as `feat(server): serve tRPC`. PRs merge by squash, so the title becomes the commit on `main` that Release Please reads. The workflow runs again when the title changes.

## Workflows

- Every action is pinned to a full commit SHA, with its version in a comment.
- zizmor audits the workflows. A finding fails the job and shows as an annotation on the PR.

## Renovate

[Renovate](https://docs.renovatebot.com) opens PRs for dependency updates. Its configuration is in `renovate.json`.

- Minor, patch, and digest updates merge on their own once CI passes. Majors wait for review.
- Renovate waits 3 days before it updates to a new npm release. pnpm's own `minimumReleaseAge` refuses anything less than a day old, so a younger version would fail the install.
- The Playwright image in `ci.yml` must have the same version as the playwright package, because the image's browsers are built for that version. After a playwright update, `scripts/renovate/playwright-image.sh` updates the image to the package's version in the same commit.
