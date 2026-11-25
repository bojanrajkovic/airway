#!/bin/sh
# Starts or stops Postgres for the database tests, with Podman or Docker. `up` returns once
# Postgres accepts connections. CI's service container in .github/workflows/ci.yml uses the same
# image digest.
set -eu
IMAGE=docker.io/library/postgres:19@sha256:aaa10f7ba7328b4a221a6c3184d83eef885bd16bf1f6de864757863156b0a4d1
runtime=$(command -v podman || command -v docker || true)
if [ -z "$runtime" ]; then
  echo "scripts/db.sh needs Podman or Docker." >&2
  exit 1
fi

case "${1:-}" in
  up)
    "$runtime" run --detach --rm --name airway-postgres --publish 127.0.0.1:54318:5432 \
      --env POSTGRES_PASSWORD=airway "$IMAGE" >/dev/null
    # The check uses TCP. While the image initializes, it runs a temporary server that listens only
    # on a local socket, so a socket check would report ready too early.
    for _ in $(seq 60); do
      if "$runtime" exec airway-postgres pg_isready --host 127.0.0.1 --quiet; then
        exit 0
      fi
      sleep 0.5
    done
    echo "Postgres didn't accept connections within 30 seconds; see: $runtime logs airway-postgres" >&2
    exit 1
    ;;
  down)
    "$runtime" stop airway-postgres >/dev/null
    ;;
  *)
    echo "Usage: scripts/db.sh up|down" >&2
    exit 2
    ;;
esac
