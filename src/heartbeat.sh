#!/usr/bin/env bash
set -euo pipefail

: "${CF_WORKER_URL:?Set CF_WORKER_URL}"
: "${HEARTBEAT_TOKEN:?Set HEARTBEAT_TOKEN}"
health_mode=${HEALTHCHECK_MODE:-tunnel}
case "$health_mode" in
  tunnel) : "${HEALTHCHECK_URL:?Set HEALTHCHECK_URL to a health endpoint served through the tunnel}" ;;
  services|tailscale) ;;
  *) printf 'Invalid HEALTHCHECK_MODE\n' >&2; exit 1 ;;
esac

if [[ $CF_WORKER_URL != https://* || ( $health_mode == tunnel && $HEALTHCHECK_URL != https://* ) ]]; then
  printf 'Worker and health-check URLs must use HTTPS\n' >&2
  exit 1
fi

for dependency in curl jq systemctl; do
  if ! command -v "$dependency" >/dev/null; then
    printf 'Missing dependency: %s\n' "$dependency" >&2
    exit 1
  fi
done

device_id=${HEARTBEAT_DEVICE_ID:-pi4}
device_name=${HEARTBEAT_DEVICE_NAME:-$device_id}
service_name=${CLOUDFLARED_SERVICE:-cloudflared}
heartbeat=1
read -r -a service_names <<<"${HEARTBEAT_SERVICES:-$service_name}"
if [[ $health_mode == tailscale ]]; then
  read -r -a service_names <<<"${HEARTBEAT_SERVICES:-tailscaled}"
fi
for service in "${service_names[@]}"; do
  if ! systemctl is-active --quiet "$service"; then
    printf 'Required service is inactive: %s\n' "$service" >&2
    heartbeat=0
  fi
done

if [[ $heartbeat == 1 && $health_mode == tunnel ]]; then
  if health_status=$(curl --fail --silent --show-error --location --max-redirs 3 \
    --proto '=https' --proto-redir '=https' --connect-timeout 5 --max-time 10 \
    --retry 1 --retry-delay 1 --retry-max-time 15 \
    --output /dev/null --write-out '%{http_code}' "$HEALTHCHECK_URL") &&
    [[ $health_status == 2[0-9][0-9] ]]; then
    heartbeat=1
  else
    printf 'Tunnel HTTP health check failed\n' >&2
    heartbeat=0
  fi
fi

if [[ $heartbeat == 1 && $health_mode == tailscale ]]; then
  if ! command -v tailscale >/dev/null ||
    ! tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null; then
    printf 'Tailscale is not authenticated/running\n' >&2
    heartbeat=0
  fi
fi

payload=$(jq -cn --arg id "$device_id" --arg name "$device_name" \
  --argjson heartbeat "$heartbeat" '{id: $id, name: $name, heartbeat: $heartbeat}')

if ! response=$(curl --fail --silent --show-error --proto '=https' \
  --connect-timeout 5 --max-time 15 --retry 2 --retry-delay 2 \
  --retry-max-time 45 --retry-connrefused \
  -H 'content-type: application/json' -H "x-heartbeat-token: $HEARTBEAT_TOKEN" \
  --data "$payload" "${CF_WORKER_URL%/}/heartbeat"); then
  printf 'Heartbeat delivery failed: id=%s\n' "$device_id" >&2
  exit 1
fi

if ! jq -e '.ok == true and (.persisted | type == "boolean")' >/dev/null <<<"$response"; then
  printf 'Unexpected heartbeat response: id=%s\n' "$device_id" >&2
  exit 1
fi
printf 'Heartbeat delivered: id=%s heartbeat=%s\n' "$device_id" "$heartbeat"
