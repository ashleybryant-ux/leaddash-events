#!/usr/bin/env bash
# Says whether each Stripe setting in .env looks right, without printing any key.
#   cd /home/ssm-user/events && bash deploy/check-stripe.sh
cd "$(dirname "$0")/.."
for k in STRIPE_SECRET_KEY:sk_,rk_ STRIPE_PUBLISHABLE_KEY:pk_ STRIPE_CONNECT_CLIENT_ID:ca_ STRIPE_CONNECT_WEBHOOK_SECRET:whsec_; do
  n=${k%%:*}
  v=$(grep -E "^$n=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'\r ")
  ok=no
  for p in $(echo "${k#*:}" | tr , ' '); do case "$v" in "$p"*) ok=yes;; esac; done
  mode=""
  case "$v" in *_live_*) mode=" (live)";; *_test_*) mode=" (test)";; esac
  if [ "$ok" = yes ]; then echo "$n: OK$mode"; else echo "$n: NOT SET RIGHT (${#v} characters, should start with ${k#*:})"; fi
done
