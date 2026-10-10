#!/usr/bin/env bash
# FIRST-TIME SETUP on the LeadDash Employees server. Run once:
#   cd /home/ssm-user && git clone https://github.com/ashleybryant-ux/leaddash-events events && cd events && bash deploy/setup.sh
# Safe to run again: it keeps an existing .env and only adds what is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== .env"
touch .env
chmod 600 .env
add() { grep -qE "^$1=" .env || echo "$1=$2" >> .env; }
add PORT 4200
add NODE_ENV production
add APP_URL https://events.leaddash.io
add DATABASE_PATH ./data/events.db
add UPLOADS_DIR ./data/uploads
add SECRETS_KEY "$(openssl rand -hex 32)"
add EMAIL_FROM_ADDRESS events@leaddash.io
add EMAIL_FROM_NAME "LeadDash Events"
add SES_REGION us-east-1
if ! grep -qE '^VAPID_PUBLIC_KEY=' .env; then
  npm ci --no-audit --no-fund
  KEYS=$(npx --yes web-push generate-vapid-keys --json)
  echo "VAPID_PUBLIC_KEY=$(echo "$KEYS" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).publicKey))')" >> .env
  echo "VAPID_PRIVATE_KEY=$(echo "$KEYS" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).privateKey))')" >> .env
fi
add VAPID_SUBJECT mailto:info@leaddash.io
add LEADDASH_STAFF_EMAILS drashleybryant@gmail.com
for k in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_CONNECT_WEBHOOK_SECRET GHL_CLIENT_ID GHL_CLIENT_SECRET; do add "$k" ""; done
add PLATFORM_FEE_CENTS 0
add PLATFORM_FEE_PERCENT 0
mkdir -p data/uploads

echo "== nginx site"
sudo cp deploy/nginx-events.conf /etc/nginx/sites-available/leaddash-events
sudo ln -sf /etc/nginx/sites-available/leaddash-events /etc/nginx/sites-enabled/leaddash-events
sudo nginx -t && sudo systemctl reload nginx

echo "== build and start"
./deploy.sh

echo "== HTTPS (needs events.leaddash.io pointing at this server)"
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
NOW=$(dig +short events.leaddash.io @1.1.1.1 | tail -1 || true)
if [ "$NOW" = "$PUBLIC" ]; then
  sudo certbot --nginx -d events.leaddash.io --non-interactive --agree-tos --register-unsafely-without-email --redirect
  curl -fsS https://events.leaddash.io/api/health && echo && echo "LeadDash Events is live at https://events.leaddash.io"
else
  echo "events.leaddash.io points to ${NOW:-nothing}, not this server ($PUBLIC)."
  echo "Add an A record: events.leaddash.io -> $PUBLIC, wait a few minutes, then run: cd /home/ssm-user/events && bash deploy/setup.sh"
fi
