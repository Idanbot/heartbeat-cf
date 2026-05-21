const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 1800;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isGet = request.method === "GET";
    const isHeartbeatRequest =
      (request.method === "POST" || isGet) && url.pathname === "/heartbeat";

    if (isGet && (url.pathname === "/" || url.pathname === "/status")) {
      const devices = await listDevices(env);
      return json(devices);
    }

    if (isHeartbeatRequest) {
      return handleHeartbeat(request, env, ctx);
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkForDownDevices(env));
  },
};

async function handleHeartbeat(request, env, ctx) {
  const url = new URL(request.url);

  const token =
    request.headers.get("x-heartbeat-token") || url.searchParams.get("token");

  if (!token || token !== env.HEARTBEAT_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  let body = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
  }

  const id = String(body.id || url.searchParams.get("id") || "").trim();
  const name = String(body.name || url.searchParams.get("name") || id).trim();

  if (!id) {
    return json({ error: "missing_id" }, 400);
  }

  const heartbeatRaw = body.heartbeat ?? url.searchParams.get("heartbeat") ?? 1;
  const heartbeat = normalizeHeartbeat(heartbeatRaw);
  const db = getDatabase(env);
  const previousRecord = await getDevice(db, id);
  const nowIso = new Date().toISOString();

  const record = {
    id,
    name,
    heartbeat,
    last_timestamp: nowIso,
    last_healthy_timestamp:
      heartbeat === 1
        ? nowIso
        : previousRecord?.last_healthy_timestamp ||
          (Number(previousRecord?.heartbeat) === 1 ? previousRecord.last_timestamp : null),
    unavailable_since_timestamp:
      heartbeat === 1
        ? null
        : previousRecord?.unavailable_since_timestamp || nowIso,
    alert_sent_at:
      heartbeat === 1 ? null : previousRecord?.alert_sent_at || null,
  };

  await upsertDevice(db, record);

  if (heartbeat === 0) {
    ctx.waitUntil(checkDeviceForDownAlert(env, record));
  }

  return json({
    ok: true,
    device: publicDeviceRecord(env, record),
  });
}

async function listDevices(env) {
  const db = getDatabase(env);
  const result = await db
    .prepare(
      `SELECT id,
              name,
              heartbeat,
              last_timestamp,
              last_healthy_timestamp,
              unavailable_since_timestamp,
              alert_sent_at
         FROM devices
        ORDER BY id`,
    )
    .all();

  return (result.results || []).map((record) => publicDeviceRecord(env, record));
}

async function checkForDownDevices(env) {
  const db = getDatabase(env);
  const result = await db
    .prepare(
      `SELECT id,
              name,
              heartbeat,
              last_timestamp,
              last_healthy_timestamp,
              unavailable_since_timestamp,
              alert_sent_at
         FROM devices`,
    )
    .all();

  for (const record of result.results || []) {
    if (isDevicePastHeartbeatTimeout(env, record)) {
      await sendDownAlertOnce(env, record, "no healthy heartbeat within timeout");
    }
  }
}

async function checkDeviceForDownAlert(env, record) {
  if (isDevicePastHeartbeatTimeout(env, record)) {
    await sendDownAlertOnce(env, record, "no healthy heartbeat within timeout");
  }
}

async function getDevice(db, id) {
  return db
    .prepare(
      `SELECT id,
              name,
              heartbeat,
              last_timestamp,
              last_healthy_timestamp,
              unavailable_since_timestamp,
              alert_sent_at
         FROM devices
        WHERE id = ?`,
    )
    .bind(id)
    .first();
}

async function upsertDevice(db, record) {
  await db
    .prepare(
      `INSERT INTO devices (
         id,
         name,
         heartbeat,
         last_timestamp,
         last_healthy_timestamp,
         unavailable_since_timestamp,
         alert_sent_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         heartbeat = excluded.heartbeat,
         last_timestamp = excluded.last_timestamp,
         last_healthy_timestamp = excluded.last_healthy_timestamp,
         unavailable_since_timestamp = excluded.unavailable_since_timestamp,
         alert_sent_at = excluded.alert_sent_at`,
    )
    .bind(
      record.id,
      record.name,
      record.heartbeat,
      record.last_timestamp,
      record.last_healthy_timestamp,
      record.unavailable_since_timestamp,
      record.alert_sent_at,
    )
    .run();
}

function publicDeviceRecord(env, record) {
  const lastHealthyTimestamp =
    record.last_healthy_timestamp ||
    (Number(record.heartbeat) === 1 ? record.last_timestamp : null);
  const fresh = isTimestampFresh(env, lastHealthyTimestamp);

  return {
    id: record.id,
    name: record.name,
    heartbeat: fresh && Number(record.heartbeat) === 1 ? 1 : 0,
    last_timestamp: record.last_timestamp,
    last_healthy_timestamp: lastHealthyTimestamp,
    unavailable_since_timestamp: record.unavailable_since_timestamp || null,
    alert_sent_at: record.alert_sent_at || null,
  };
}

function isDevicePastHeartbeatTimeout(env, record) {
  const lastHealthyTimestamp =
    record.last_healthy_timestamp ||
    (Number(record.heartbeat) === 1 ? record.last_timestamp : null);
  const referenceTimestamp =
    lastHealthyTimestamp || record.unavailable_since_timestamp || record.last_timestamp;

  return !isTimestampFresh(env, referenceTimestamp);
}

function isTimestampFresh(env, timestamp) {
  const referenceMs = Date.parse(timestamp);

  if (!Number.isFinite(referenceMs)) {
    return false;
  }

  return Date.now() - referenceMs <= heartbeatTimeoutSeconds(env) * 1000;
}

async function sendDownAlertOnce(env, device, reason) {
  if (device.alert_sent_at) return;

  const text =
    "🚨 Tunnel/device down\n" +
    "ID: " +
    device.id +
    "\nName: " +
    device.name +
    "\nReason: " +
    reason +
    "\nLast heartbeat: " +
    device.last_timestamp +
    "\nLast healthy heartbeat: " +
    (device.last_healthy_timestamp || "unknown") +
    "\nUnavailable since: " +
    (device.unavailable_since_timestamp || "unknown");

  await sendTelegram(env, text);

  await getDatabase(env)
    .prepare("UPDATE devices SET alert_sent_at = ? WHERE id = ? AND alert_sent_at IS NULL")
    .bind(new Date().toISOString(), device.id)
    .run();
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram secrets are missing");
    return;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    },
  );

  if (!res.ok) {
    console.error("Telegram send failed", await res.text());
  }
}

function heartbeatTimeoutSeconds(env) {
  const value = Number(env.HEARTBEAT_TIMEOUT_SECONDS || DEFAULT_HEARTBEAT_TIMEOUT_SECONDS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
}

function normalizeHeartbeat(value) {
  if (value === true || value === 1) return 1;

  const str = String(value).toLowerCase().trim();

  if (["1", "true", "up", "ok", "healthy"].includes(str)) return 1;
  if (["0", "false", "down", "fail", "unhealthy"].includes(str)) return 0;

  return 0;
}

function getDatabase(env) {
  if (!env.DB) {
    throw new Error("Missing DB D1 binding");
  }

  return env.DB;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}
