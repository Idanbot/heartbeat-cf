# Device Heartbeat Monitor

Cloudflare Worker that records device heartbeats in D1 and sends a Telegram alert only after a device has had no healthy heartbeat for the configured timeout.

## Endpoints

- `GET /` or `GET /status`: list known devices and their current heartbeat state.
- `POST /heartbeat`: record a heartbeat. Requires `x-heartbeat-token` or `?token=`.
- `GET /heartbeat`: also accepted for simple clients, with `id`, `name`, `heartbeat`, and `token` query parameters.

Example heartbeat:

```sh
curl -fsS -X POST "$CF_WORKER_URL/heartbeat" \
  -H "content-type: application/json" \
  -H "x-heartbeat-token: $HEARTBEAT_TOKEN" \
  --data '{"id":"pi4","name":"Hermes Pi 4","heartbeat":1}'
```

## Configuration

`wrangler.toml` defines the Worker, cron trigger, `DB` D1 binding, and `HEARTBEAT_TIMEOUT_SECONDS`. The default timeout is 1800 seconds, so alerts wait for 30 minutes without a healthy heartbeat. Repeated `heartbeat=0` reports keep the device marked down, but they do not reset the 30-minute alert window. Healthy heartbeats clear any previous alert state.

Create the D1 database, copy its `database_id` into `wrangler.toml`, and apply the migration:

```sh
wrangler d1 create device-heartbeat-monitor
wrangler d1 migrations apply device-heartbeat-monitor --remote
```

Runtime secrets must be set through Wrangler secrets:

```sh
wrangler secret put HEARTBEAT_TOKEN
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

For the client script, copy `.env.example` to a local environment file or export these variables in the service environment:

```sh
export CF_WORKER_URL="https://device-heartbeat-monitor.example.workers.dev"
export HEARTBEAT_TOKEN="replace-with-a-long-random-token"
```

Run the client every 5 minutes. With D1 this is comfortably inside the free tier for a small number of devices, and it gives a 30-minute alert window six chances to receive a healthy heartbeat before alerting. For example, with cron:

```cron
*/5 * * * * /path/to/heartbeat.sh
```

The Worker no longer uses KV-backed rate limiting because that consumed a write on every request. The heartbeat endpoint is protected by `HEARTBEAT_TOKEN`. For stronger protection against malicious traffic before it reaches the Worker, add Cloudflare WAF or account-level rate limiting rules for `/heartbeat` and `/status`.

Do not commit `.env`, `.dev.vars`, `.wrangler`, or local D1/Miniflare state. They are ignored because they can contain account data, local state, or secrets.

## Local Development

```sh
wrangler dev
```

Local Wrangler state is written under `.wrangler/` and is intentionally ignored.

## Deploy

```sh
wrangler deploy
```
