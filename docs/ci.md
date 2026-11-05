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
- Only pushes to `main` write caches: mise's tools, and the pnpm store keyed on the lockfile. Pull requests restore `main`'s caches and save none. pnpm checks every package it takes from the store against the lockfile's integrity hash, so a cache can make installs faster but can't change what's installed.

## The ruleset on main

`main` has one ruleset. It requires Check to pass and nothing else: branches don't have to be up to date, and the maintainer can bypass it. Why it exists: without a required check, GitHub merges an automerge PR before CI has run.

Create it once Check has run on `main`, after the first PR lands. The `integration_id` limits the required check to GitHub Actions, so another app can't report a passing Check:

```sh
gh api repos/bojanrajkovic/airway/rulesets --method POST --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "Check", "integration_id": 15368 }]
      }
    }
  ]
}
EOF
```

Actor 5 is the repository admin role.
