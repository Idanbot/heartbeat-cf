#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
bundle="${1:?Bundle directory required}"
for tool in bash curl jq systemctl; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
if ! id device-heartbeat >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin device-heartbeat
fi
install -d -m 0755 /opt/device-heartbeat
install -m 0755 "${bundle}/heartbeat.sh" /opt/device-heartbeat/heartbeat.sh
install -m 0600 "${bundle}/heartbeat.env" /etc/device-heartbeat.env
install -m 0644 "${bundle}/device-heartbeat.service" "${bundle}/device-heartbeat.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start device-heartbeat.service
systemctl enable --now device-heartbeat.timer
echo 'Heartbeat installed and first delivery verified.'
