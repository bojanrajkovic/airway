#!/usr/bin/env bash
# Renovate runs this after a Playwright update. The browser tests run in Playwright's image, whose
# browsers must match the playwright package in the pnpm catalog. This moves every Playwright image
# in the workflows to the catalog's version, keeping each one's distro, and pins the new image's
# digest. It changes nothing when the versions already match. Run it from the repo root.
set -euo pipefail

want=$(sed -nE 's/^  playwright: "?([0-9.]+)"?$/\1/p' pnpm-workspace.yaml)
if [[ -z $want ]]; then
  echo "playwright-image: no playwright version in the pnpm-workspace.yaml catalog" >&2
  exit 1
fi

pattern='mcr\.microsoft\.com/playwright:v[0-9.]+-[a-z]+@sha256:[0-9a-f]{64}'
mapfile -t files < <(grep -rlE "$pattern" .github/workflows || true)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "playwright-image: no digest-pinned Playwright image in .github/workflows" >&2
  exit 1
fi

mapfile -t refs < <(grep -hoE "$pattern" "${files[@]}" | sort -u)
for ref in "${refs[@]}"; do
  [[ $ref =~ :v([0-9.]+)-([a-z]+)@ ]]
  have=${BASH_REMATCH[1]}
  distro=${BASH_REMATCH[2]}
  if [[ $have == "$want" ]]; then
    continue
  fi

  image="mcr.microsoft.com/playwright:v${want}-${distro}"
  if ! digest=$(mise x aqua:google/go-containerregistry -- crane digest "$image"); then
    echo "playwright-image: can't resolve $image; has Microsoft published the image yet?" >&2
    exit 1
  fi

  sed -i "s|${ref//./\\.}|${image}@${digest}|g" "${files[@]}"
  echo "playwright-image: workflows now use ${image}@${digest}"
done
