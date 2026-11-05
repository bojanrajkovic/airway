#!/bin/sh
# Starts Postgres 18 for the database tests and returns once it accepts connections.
# CI's service container in .github/workflows/ci.yml uses the same image digest.
set -eu
podman run --detach --rm --name airway-postgres --publish 127.0.0.1:54318:5432 \
  --env POSTGRES_PASSWORD=airway \
  docker.io/library/postgres:18@sha256:bd5dfa494a5a259704365813dbfa5fa6b3e69be7348d43b547f540c730478583 \
  >/dev/null
# Checks over TCP: while the image initializes, it runs a temporary server that only listens on a
# local socket, so a socket check would report ready too early.
for _ in $(seq 60); do
  if podman exec airway-postgres pg_isready --host 127.0.0.1 --quiet; then
    exit 0
  fi
  sleep 0.5
done
echo "Postgres didn't accept connections within 30 seconds; see: podman logs airway-postgres" >&2
exit 1
