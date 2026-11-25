---
name: release-notes
description: Write plain-language notes into airway's open Release Please PR before it merges. Use when the maintainer asks for release notes, asks to cut or prepare a release, or mentions the release PR.
---

# Release notes

Release Please keeps one release PR open (label `autorelease: pending`) with notes generated from commit titles. This skill replaces them with notes that a person who uses airway can read, then hands the PR back to the maintainer to merge. Merging it tags the release, and the GitHub release takes its notes from the PR body. [docs/release.md](../../../docs/release.md) describes the whole flow.

## 1. Gather

```sh
gh pr list --label "autorelease: pending" --json number,title,body   # the release PR
git fetch --tags origin main
git describe --tags --abbrev=0 origin/main                          # the last release's tag; if no tag exists, this release is the first
git log --format='%s' <last-tag>..origin/main                       # squash titles, each ending in (#N)
```

For the first release, use every commit on `main`. Read the body of each PR in the range (`gh pr view <N> --json title,body`). The squash title alone often hides what changed.

Then check for data changes since the last tag:

```sh
git diff <last-tag>..origin/main -- docs/scoring.md   # a new derived_version entry
git log --format='%s' <last-tag>..origin/main | grep -E '^[a-z]+(\([^)]*\))?!:'   # breaking titles
```

A new `derived_version` entry means airway re-derives every night on deploy. When a PR with a breaking title migrates the notes schema, its body says how the stored notes change.

## 2. Draft

Write for the person who reads the trends page, not for a developer:

- Group by what someone notices: new things they can do, things that now work right, things that look different. Leave out `chore`, `ci`, `build`, `test`, `docs`, and refactors unless they change what a user sees.
- One line per change, in plain words. Name the page or tool, not the module. Link the PR as `(#N)`.
- For a breaking release, add a **Data changes** section: what happens to the data on deploy (re-derived nights, migrated notes), which numbers move and why (from the `docs/scoring.md` entry), and whether anything needs doing by hand.
- The repo is public. Never put real CPAP values, dates of real nights, names, or serial numbers in the notes.

Show the maintainer the draft and wait for changes or approval. Write to the PR only after they approve.

## 3. Write it into the PR

The release PR body has this shape. Release Please reads the version from the `##` heading when the PR merges. Keep the header, that heading, and the footer exactly as they are, and replace only the notes between the heading and the footer's `---`. The heading links to a compare page in every release except the first (`## 0.1.0 (2026-01-02)`):

```markdown
:robot: I have created a release *beep* *boop*
---


## [0.2.0](https://github.com/bojanrajkovic/airway/compare/v0.1.0...v0.2.0) (2026-01-02)

<the notes go here>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).
```

Save the new body to a file, check that the header line, the `##` version heading, and the footer line are all still there, then apply it:

```sh
gh pr edit <N> --body-file <file>
```

Release Please rewrites the body whenever a commit lands on `main`, so tell the maintainer that the notes are in place and that the PR is ready to merge now. Merge it yourself only if they ask.
