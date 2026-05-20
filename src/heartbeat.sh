#!/usr/bin/env bash
set -euo pipefail

WORKER_URL=$CF_WORKER_URL
TOKEN=$HEARTBEAT_TOKEN

ID="pi4"
NAME="Hermes Pi 4"

if systemctl is-active --quiet cloudflared; then
  HEARTBEAT=1
else
  HEARTBEAT=0
fi

curl -fsS -X POST "$WORKER_URL/heartbeat" \
  -H "content-type: application/json" \
  -H "x-heartbeat-token: $TOKEN" \
  --data "{
    \"id\": \"$ID\",
    \"name\": \"$NAME\",
    \"heartbeat\": $HEARTBEAT
  }" >/dev/null
