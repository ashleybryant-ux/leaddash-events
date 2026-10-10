#!/usr/bin/env bash
# Sets lines in .env (replacing a key that is already there), then restarts the app.
#   cd /home/ssm-user/events && bash deploy/set-env.sh 'STRIPE_SECRET_KEY=sk_live_...' 'STRIPE_CONNECT_CLIENT_ID=ca_...'
set -euo pipefail
cd "$(dirname "$0")/.."
touch .env && chmod 600 .env
for pair in "$@"; do
  key="${pair%%=*}"
  case "$key" in ""|*[!A-Z0-9_]*) echo "Skipped: $pair (not KEY=value)"; continue;; esac
  grep -v -E "^${key}=" .env > .env.tmp || true
  printf '%s\n' "$pair" >> .env.tmp
  mv .env.tmp .env && chmod 600 .env
  echo "set $key"
done
pm2 restart leaddash-events --update-env > /dev/null 2>&1 && echo "restarted leaddash-events" || echo "leaddash-events is not running yet; run ./deploy.sh"
