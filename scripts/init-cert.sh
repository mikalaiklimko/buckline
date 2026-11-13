#!/bin/sh
# One-time: issue the first Let's Encrypt certificate for onebuckline.com.
# Run on the server from the deploy directory, with DNS already pointing here.
# Usage: scripts/init-cert.sh [email]
set -eu
DOMAIN=onebuckline.com

if [ -n "${1:-}" ]; then ACCOUNT="--email $1"; else ACCOUNT="--register-unsafely-without-email"; fi

# Port 80 must be free for the standalone challenge.
docker compose stop nginx 2>/dev/null || true

docker run --rm -p 80:80 \
  -v buckline_letsencrypt:/etc/letsencrypt \
  certbot/certbot:v2.11.0 certonly --standalone \
  -d "$DOMAIN" $ACCOUNT --agree-tos --non-interactive

docker compose up -d
