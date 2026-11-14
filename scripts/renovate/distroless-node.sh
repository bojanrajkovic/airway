#!/usr/bin/env bash
# Renovate runs this after a Node.js major update. The distroless runtime image's name holds the
# Node major (gcr.io/distroless/nodejs26-debian13), and Renovate only updates its digest. This
# renames the image to the major in mise.toml and pins the new image's digest. It changes nothing
# when the majors already match. Run it from the repo root.
set -euo pipefail

node_version=$(sed -nE 's/^node = "([0-9.]+)"$/\1/p' mise.toml)
want=${node_version%%.*}
if [[ -z $want ]]; then
  echo "distroless-node: no node version in mise.toml" >&2
  exit 1
fi

from=$(grep -E '^FROM gcr\.io/distroless/nodejs[0-9]+-debian[0-9]+:nonroot@sha256:[0-9a-f]{64}$' Dockerfile || true)
if [[ $(grep -c . <<<"$from") -ne 1 ]]; then
  echo "distroless-node: expected one distroless FROM line in Dockerfile, found: ${from:-none}" >&2
  exit 1
fi
[[ $from =~ nodejs([0-9]+)-(debian[0-9]+) ]]
have=${BASH_REMATCH[1]}
debian=${BASH_REMATCH[2]}

if [[ $have == "$want" ]]; then
  exit 0
fi

image="gcr.io/distroless/nodejs${want}-${debian}:nonroot"
if ! digest=$(mise x aqua:google/go-containerregistry -- crane digest "$image"); then
  echo "distroless-node: can't resolve $image; does distroless publish Node $want on $debian yet?" >&2
  exit 1
fi

sed -i -E "s|^FROM gcr\.io/distroless/nodejs[0-9]+-debian[0-9]+:nonroot@sha256:[0-9a-f]{64}$|FROM ${image}@${digest}|" Dockerfile
echo "distroless-node: Dockerfile now uses ${image}@${digest}"
