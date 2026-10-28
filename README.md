# Device Heartbeat Monitor

Cloudflare Worker with D1 storage and Telegram outage alerts. Clients report every five minutes; an alert becomes eligible only after **more than 30 minutes** without a stored healthy heartbeat.

## Endpoints

| Endpoint | Authentication | Result |
| --- | --- | --- |
| `POST /heartbeat` | `x-heartbeat-token: HEARTBEAT_TOKEN` | Accept a JSON heartbeat |
| `GET /heartbeat?id=pi4&heartbeat=1` | `x-heartbeat-token: HEARTBEAT_TOKEN` | Accept a heartbeat from a simple client |
| `GET /public/status` or `/` | None, only when explicitly enabled | Minimal public status feed for allowlisted devices |
| `GET /status` | `x-status-token: STATUS_TOKEN` | Detailed device status array |
| `GET /health` | `x-status-token: STATUS_TOKEN` | Check the D1 binding and migrated schema |

URL tokens are no longer accepted. Keep the read and write tokens different. Missing server-side secrets fail closed with `503`; invalid credentials return `401` before querying D1.

The public feed is deliberately enabled for this portfolio in `wrangler.toml` using
`PUBLIC_STATUS_ENABLED="true"` and the explicit `PUBLIC_DEVICE_IDS` allowlist. It
exposes **only** `id`, `name`, `heartbeat`, and `last_timestamp`; device names and
presence are public information. New devices stay private until allowlisted.
It supports anonymous GET and OPTIONS with wildcard CORS, never credentialed CORS,
and performs no writes or alert delivery. `/` is a compatibility alias for the
existing website. Without the opt-in, `/` retains authenticated behavior and
`/public/status` is unavailable. An empty allowlist exposes no devices. `/status`,
`/health`, and heartbeat writes remain authenticated. Never put either token in
frontend code. Public reads consume Worker/D1 quotas; monitor usage before
promoting the dashboard to a larger audience.

```sh
curl -fsS -X POST "$CF_WORKER_URL/heartbeat" \
  -H 'content-type: application/json' \
  -H "x-heartbeat-token: $HEARTBEAT_TOKEN" \
  --data '{"id":"pi4","name":"Hermes Pi 4","heartbeat":1}'

curl -fsS "$CF_WORKER_URL/status" -H "x-status-token: $STATUS_TOKEN"
```

Device IDs must start with a letter or digit, contain only letters, digits, `_`, `.`, or `-`, and be at most 64 characters. Names are nonempty strings of at most 128 characters without control characters. JSON bodies are limited to 4096 bytes. Heartbeats must explicitly contain `0`, `1`, `false`, `true`, or one of the existing string aliases (`up`, `ok`, `healthy`, `down`, `fail`, `unhealthy`, `true`, `false`, `0`, `1`). Other values return `400` without accessing D1.

Status reads default to 100 devices and accept `?limit=1..100&after=<last-id>`. An `x-next-cursor` response header identifies the next page when one exists. Delivery claims and retry internals are not exposed.

## Timing and Delivery

`HEARTBEAT_TIMEOUT_SECONDS` defaults to `1800`. Repeated unhealthy reports preserve the last healthy timestamp and the first unavailable timestamp. A device first registered as unhealthy also gets a full 30-minute grace period. A healthy heartbeat resets the outage and its alert/retry state.

`HEARTBEAT_WRITE_INTERVAL_SECONDS` defaults to `300`. Unchanged reports are persisted at most once per five minutes; state and name changes persist immediately. The response includes `persisted: false` when the report was accepted without updating stored timestamps. Run clients every five minutes so almost every scheduled report is persisted. If sending more frequently, timeout calculations use the last **persisted** healthy timestamp, which can lag received reports by up to the write interval.

The five-minute cron checks overdue, unalerted devices using a partial expression index. For a small fleet, first delivery is normally 30-35 minutes after the last stored healthy heartbeat, subject to scheduler/network delays. Each invocation processes at most ten eligible devices to bound Worker subrequests; larger simultaneous outages take additional batches.

An atomic, two-minute D1 lease prevents overlapping heartbeat/cron checks from sending the same active attempt. Telegram requests time out after ten seconds. Alerts are marked sent only after an HTTP success with Telegram `ok: true`. Missing credentials, API errors, and network failures remain retryable. Retry delays start at 60 seconds and double to a maximum of one hour; Telegram `retry_after` is honored up to 24 hours. The next cron or unhealthy report performs the retry after its due time. Expired claims recover automatically after an interrupted Worker.

Successful delivery is recorded once per outage and recovery allows the next outage to alert. Telegram and D1 cannot commit atomically: a crash after Telegram accepts a message but before D1 records success may cause a duplicate retry. An already in-flight message may arrive after recovery, but its completion cannot mark a later outage as sent.

At a five-minute cadence, each stable device performs about 288 heartbeat row updates per day, plus index writes and outage bookkeeping. D1 still has finite quotas; inspect `Metrics > Row Metrics` and the structured `down_check`, `alert_delivered`, and `alert_failed` logs. Unauthorized requests to private endpoints do not access storage; intentionally public feed reads do. This application has no KV writes or KV-backed rate limiter. See [D1 usage accounting](https://developers.cloudflare.com/d1/platform/pricing/) and [Telegram responses](https://core.telegram.org/bots/api#making-requests).

## Worker Deployment

Use Node.js 24 or newer:

```sh
npm ci
npm test
```

For an existing deployment, **apply migration `0002_alert_delivery.sql` before deploying this Worker**. It preserves existing device/alert records and adds delivery claims, retries, and the pending-alert index. The D1 database is already configured in `wrangler.toml`; a new installation must create a database with `npx wrangler d1 create device-heartbeat-monitor` and update its ID first.

```sh
npx wrangler d1 migrations apply device-heartbeat-monitor --remote
npx wrangler secret put STATUS_TOKEN
```

Keep existing `HEARTBEAT_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` secrets. Set them with `npx wrangler secret put <NAME>` for a new installation. Then deploy and verify using the same read token you configured above:

```sh
npm run deploy
export CF_WORKER_URL="https://your-worker.workers.dev"
read -rs STATUS_TOKEN
export STATUS_TOKEN
npm run smoke
```

The smoke test checks denied anonymous status access, authenticated D1/schema health, and a bounded status read. It sends no heartbeats or Telegram messages and creates no device records.

## Client Installation

Clients support three explicit health scopes:

| `HEALTHCHECK_MODE` | Healthy means |
| --- | --- |
| `tunnel` (default) | Required services active and an HTTPS endpoint returns final `2xx`, with at most three HTTPS redirects |
| `services` | All space-separated `HEARTBEAT_SERVICES` are active; **not** an end-to-end tunnel check |
| `tailscale` | Required services active and `tailscale status --json` reports `BackendState=Running`; not a peer-connectivity test |

Only `tunnel` requires `HEALTHCHECK_URL`. For Linux, install `bash`, `curl`, and `jq`. Configure a dedicated health endpoint reachable through the public tunnel when using `tunnel`; a running process alone does not prove a tunnel works.

Install the versioned client and units from this checkout:

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin device-heartbeat
sudo install -d -m 0755 /opt/device-heartbeat
sudo install -m 0755 src/heartbeat.sh /opt/device-heartbeat/heartbeat.sh
sudo install -m 0600 .env.example /etc/device-heartbeat.env
sudoedit /etc/device-heartbeat.env
sudo install -m 0644 systemd/device-heartbeat.service systemd/device-heartbeat.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now device-heartbeat.timer
sudo systemctl start device-heartbeat.service
```

Create the account only if it does not exist. In `/etc/device-heartbeat.env`, set `CF_WORKER_URL`, `HEARTBEAT_TOKEN`, the chosen health scope, and device identity. This file uses systemd environment syntax: assignments only, no `export` or shell expansion. Keep Worker-only Telegram/read secrets off the device. The systemd manager loads the root-owned environment before running the service as a dedicated unprivileged account. A static account is intentional: the system D-Bus rejects service queries from unmapped dynamic users on the deployed hosts.

Disable any previous heartbeat cron entry or timer to avoid duplicate scheduling. Do not run the new and old clients together. Check operation with:

```sh
systemctl list-timers device-heartbeat.timer
journalctl -u device-heartbeat.service -n 20 --no-pager
```

The timer runs after one minute at boot, then every five minutes. Requests have bounded connection/total timeouts and retries; the service has a 100-second limit. An inactive tunnel or failed HTTP probe sends `heartbeat=0`. Delivery failures exit nonzero and appear in the journal. Each scheduled run reruns the probe; curl retries within that run reuse its freshly sampled payload.

For an existing installation, update the script and units above while keeping its configured environment file. If using cron instead, explicitly load the client environment in a wrapper and schedule that wrapper with `*/5 * * * *`; the script never sources a file implicitly.

### Native Windows client

Copy `src/heartbeat.ps1`, `scripts/install-windows.ps1`, and a private `config.json` based on `.env.windows.example.json` into one directory. In an administrator PowerShell, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1
Get-ScheduledTaskInfo -TaskName DeviceHeartbeat
```

The installer protects `%ProgramData%\DeviceHeartbeat` with SYSTEM/Administrators-only permissions, verifies delivery, then registers a SYSTEM task every five minutes and at startup. Only after this succeeds does it disable the exact legacy `pc1 Heartbeat` task; that task and its old files remain recoverable. The execution-policy override is process-local. Run `heartbeat.ps1 -ValidateOnly` to inspect the health payload without posting it. Delivery errors produce a nonzero task result.

### This fleet

From this repository on the administration machine:

```sh
# Optional key enrollment if Windows SSH does not accept your key; enter password locally.
node scripts/enroll-windows-key.mjs pc1
npx wrangler login
node scripts/prepare-deployment.mjs
node scripts/deploy-clients.mjs pi4
node scripts/deploy-clients.mjs micro
node scripts/deploy-clients.mjs pc1
```

Preparation reads the existing Pi's Worker URL/write credential over SSH, preserves or creates a separate read token, and uploads that read token. It stores secrets only in ignored, mode-0600 `.env.deploy.json`; do not commit or share it. Add `SSH_TARGETS.micro` to that private file with your Micro's SSH host or alias (see `.env.deploy.example.json`). Actual server addresses must stay in the ignored file or your SSH config, not source control. Deployment copies only the URL/write credential to clients. Review the non-secret device inventory in `scripts/deploy-clients.mjs` before using it elsewhere.

Pi `pi4` and Windows `pc1` check `cloudflared` in `services` mode. OCI `oci-micro` uses `tailscale` mode and checks both `tailscaled` and `wg-quick@wg0`. IDs are preserved, and `t420` is not modified. Linux uses the hardened timer above. The deployment helper backs up Pi's crontab and removes only active entries referencing the exact legacy heartbeat script, after first successful delivery. Windows preserves its old task disabled. Remote credential staging directories are private and cleaned up.

This heartbeat detects outages; it does **not** generate meaningful CPU/network load or guarantee protection from OCI idle reclamation.

## Development and Tests

Copy `.dev.vars.example` to ignored `.dev.vars`, then:

```sh
npx wrangler d1 migrations apply device-heartbeat-monitor --local
npm run dev
```

Tests use Node's test runner and real SQLite with a small D1 API adapter. They exercise the production SQL, the 30-minute boundary, five-minute persistence, delivery failures/backoff, concurrent claims, interrupted attempts, recovery races, authenticated pagination, schema checks, input limits, and the shell client's probes/encoding. Client tests require `bash` and `jq` and replace network/systemd commands with local fixtures. GitHub Actions runs these checks and a Wrangler bundle dry run on pushes and pull requests.

Do not commit `.env`, `.dev.vars`, `.wrangler`, credentials, or local SQLite state. Only example configuration files belong in Git.
