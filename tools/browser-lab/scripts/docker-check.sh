#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -t browser-lab:0.1.0 .
container=$(docker create --init --network=none --shm-size=1g --memory=3g --cpus=2 --pids-limit=512 browser-lab:0.1.0)
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker start -a "$container" || true
status=$(docker inspect --format '{{.State.ExitCode}}' "$container")
out="evidence/docker-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
docker cp "$container:/work/browser-lab/evidence/." "$out/"
printf 'Evidence: %s\nExit code: %s\n' "$out" "$status"
exit "$status"
