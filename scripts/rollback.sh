#!/bin/sh
# Switch back to the previous app image and restart.
# Run on the server from the deploy directory: sh scripts/rollback.sh
set -eu
docker image inspect buckline:previous >/dev/null 2>&1 || { echo "No previous image to roll back to." >&2; exit 1; }
docker tag buckline:previous buckline:latest
docker compose up -d --no-build buckline
echo "Rolled back to: $(docker image inspect buckline:latest --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
