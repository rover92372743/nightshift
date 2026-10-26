#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu/Debian VPS. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/rover92372743/nightshift/main/deploy/setup.sh | bash
# Then edit /opt/nightshift/.env and run: cd /opt/nightshift && docker compose up -d --build
set -euo pipefail

REPO="https://github.com/rover92372743/nightshift.git"
DIR="/opt/nightshift"

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl git ufw
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Firewall: allow SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Fetching the repo"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi

cd "$DIR"
if [ ! -f .env ]; then
  cp deploy/env.example .env
  KEY=$(openssl rand -base64 24 | tr '+/' '-_')
  sed -i "s|^NIGHTSHIFT_ADMIN_KEY=.*|NIGHTSHIFT_ADMIN_KEY=$KEY|" .env
  echo
  echo "==> Wrote $DIR/.env with a fresh admin key: $KEY"
  echo "    Now set API_DOMAIN and CORS_ORIGINS in that file, then run:"
  echo "    cd $DIR && docker compose up -d --build"
else
  echo "==> .env already exists; rebuilding and restarting"
  docker compose up -d --build
fi
