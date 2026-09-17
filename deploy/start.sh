#!/bin/sh
set -eu
umask 077

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Engine with the Compose plugin is required.' >&2
  exit 1
fi

if [ ! -f .env ]; then
  sed -e 's/^HOST=.*/HOST=0.0.0.0/' \
      -e 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' .env.example > .env
  chmod 600 .env
  echo 'Created .env for Docker. Review it, then run this script again.'
  exit 1
fi

if ! grep -qx 'HOST=0.0.0.0' .env || ! grep -qx 'PORT=8787' .env; then
  echo 'Set HOST=0.0.0.0 and PORT=8787 in .env.' >&2
  echo 'The Compose port is bound only to the host loopback; serve it through HTTPS.' >&2
  exit 1
fi
if ! grep -qx 'COOKIE_SECURE=true' .env; then
  echo 'WARNING: COOKIE_SECURE is not true. Use this only while the public endpoint is HTTP.' >&2
fi

docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 120 bridge
docker compose ps bridge
echo 'Ready on the host at http://127.0.0.1:8787/healthz (public access requires HTTPS).'
echo 'First-run admin login: docker compose exec bridge cat /app/data/admin-token.txt'
