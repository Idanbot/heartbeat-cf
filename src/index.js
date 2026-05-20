const DEVICE_PREFIX = "device:";
const ALERT_PREFIX = "alert:down:";

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

  const record = {
    id,
    name,
    heartbeat,
    last_timestamp: new Date().toISOString(),
  };

  const devices = getDevicesNamespace(env);
  await devices.put(DEVICE_PREFIX + id, JSON.stringify(record));

  if (heartbeat === 0) {
    ctx.waitUntil(sendDownAlertOnce(env, record, "reported heartbeat=0"));
  } else {
    await devices.delete(ALERT_PREFIX + id);
  }

  return json({
    ok: true,
    device: record,
  });
}

async function listDevices(env) {
  const devices = getDevicesNamespace(env);
  const now = Date.now();
  const timeoutMs = Number(env.HEARTBEAT_TIMEOUT_SECONDS || 120) * 1000;

  const records = [];

  let cursor;
  do {
    const options = { prefix: DEVICE_PREFIX };
    if (cursor) options.cursor = cursor;

    const result = await devices.list(options);

    for (const key of result.keys) {
      const record = await devices.get(key.name, { type: "json" });
      if (!record) continue;

      const lastMs = Date.parse(record.last_timestamp);
      const fresh = Number.isFinite(lastMs) && now - lastMs <= timeoutMs;

      records.push({
        id: record.id,
        name: record.name,
        heartbeat: fresh && Number(record.heartbeat) === 1 ? 1 : 0,
        last_timestamp: record.last_timestamp,
      });
    }

    cursor = result.cursor;
    if (result.list_complete) break;
  } while (cursor);

  records.sort((a, b) => a.id.localeCompare(b.id));
  return records;
}

async function checkForDownDevices(env) {
  const devices = getDevicesNamespace(env);
  const deviceRecords = await listDevices(env);

  for (const device of deviceRecords) {
    if (device.heartbeat === 0) {
      await sendDownAlertOnce(env, device, "missed heartbeat timeout");
    } else {
      await devices.delete(ALERT_PREFIX + device.id);
    }
  }
}

async function sendDownAlertOnce(env, device, reason) {
  const devices = getDevicesNamespace(env);
  const alertKey = ALERT_PREFIX + device.id;
  const alreadyAlerted = await devices.get(alertKey);

  if (alreadyAlerted) return;

  const text =
    `🚨 Tunnel/device down\n` +
    `ID: ${device.id}\n` +
    `Name: ${device.name}\n` +
    `Reason: ${reason}\n` +
    `Last heartbeat: ${device.last_timestamp}`;

  await sendTelegram(env, text);

  await devices.put(alertKey, new Date().toISOString());
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

function normalizeHeartbeat(value) {
  if (value === true || value === 1) return 1;

  const str = String(value).toLowerCase().trim();

  if (["1", "true", "up", "ok", "healthy"].includes(str)) return 1;
  if (["0", "false", "down", "fail", "unhealthy"].includes(str)) return 0;

  return 0;
}

function getDevicesNamespace(env) {
  if (!env.DEVICES) {
    throw new Error("Missing DEVICES KV binding");
  }

  return env.DEVICES;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
