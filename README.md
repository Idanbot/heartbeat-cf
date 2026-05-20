# Device Heartbeat Monitor

Cloudflare Worker that records device heartbeats in KV and sends a Telegram alert when a device reports down or misses the heartbeat timeout.

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

`wrangler.toml` defines the Worker, cron trigger, and `DEVICES` KV binding. Runtime secrets must be set through Wrangler secrets:

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

Do not commit `.env`, `.dev.vars`, `.wrangler`, or Miniflare SQLite state. They are ignored because they can contain account data, local state, or secrets.

## Local Development

```sh
wrangler dev
```

Local Wrangler state is written under `.wrangler/` and is intentionally ignored.

## Deploy

```sh
wrangler deploy
```
