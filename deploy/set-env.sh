#!/usr/bin/env bash
# Sets lines in .env (replacing a key that is already there), then restarts the app.
#   bash deploy/set-env.sh 'KEY=value' 'OTHER=value'
#   bash deploy/set-env.sh STRIPE_CONNECT_WEBHOOK_SECRET    (asks for the value, so nothing is typed into the command)
set -euo pipefail
cd "$(dirname "$0")/.."
touch .env && chmod 600 .env
for pair in "$@"; do
  if [[ "$pair" != *=* ]]; then
    read -r -p "Paste the value for $pair and press Enter: " value < /dev/tty
    pair="$pair=$value"
  fi
  key="${pair%%=*}"
  case "$key" in ""|*[!A-Z0-9_]*) echo "Skipped: $key (not a setting name)"; continue;; esac
  grep -v -E "^${key}=" .env > .env.tmp || true
  printf '%s\n' "$pair" >> .env.tmp
  mv .env.tmp .env && chmod 600 .env
  echo "set $key"
done
pm2 restart leaddash-events --update-env > /dev/null 2>&1 && echo "restarted leaddash-events" || echo "leaddash-events is not running yet; run ./deploy.sh"
