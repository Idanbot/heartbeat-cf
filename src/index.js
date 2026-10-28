const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_WRITE_INTERVAL_SECONDS = 300;
const ALERT_CLAIM_SECONDS = 120;
const ALERT_BATCH_SIZE = 10;
const MAX_BODY_BYTES = 4096;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PUBLIC_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};
const REFERENCE_TIMESTAMP =
  "COALESCE(last_healthy_timestamp, unavailable_since_timestamp, last_timestamp)";

export default {
  async fetch(request, env, ctx) {
    let publicRequest = false;
    try {
      const url = new URL(request.url);
      publicRequest = env.PUBLIC_STATUS_ENABLED === "true" &&
        ["/", "/public/status"].includes(url.pathname);
      if (publicRequest) {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: PUBLIC_CORS_HEADERS });
        }
        if (request.method !== "GET") {
          return json({ error: "method_not_allowed" }, 405, { ...PUBLIC_CORS_HEADERS, allow: "GET, OPTIONS" });
        }
        return json(await listPublicDevices(env), 200, PUBLIC_CORS_HEADERS);
      }
      if (["/", "/status", "/health"].includes(url.pathname)) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const denied = authorize(request, env.STATUS_TOKEN, "x-status-token");
        if (denied) return denied;

        if (url.pathname === "/health") {
          await getDatabase(env)
            .prepare(
              `SELECT alert_claim_token, alert_claim_until, alert_retry_at, alert_attempts
                 FROM devices LIMIT 1`,
            )
            .first();
          return json({ ok: true, database: "ok" });
        }
        return await listDevices(env, url);
      }

      if (url.pathname === "/heartbeat") {
        if (!["GET", "POST"].includes(request.method)) {
          return methodNotAllowed("GET, POST");
        }
        const denied = authorize(request, env.HEARTBEAT_TOKEN, "x-heartbeat-token");
        if (denied) return denied;
        return await handleHeartbeat(request, env, ctx, url);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof InputError) {
        return json({ error: error.message }, error.status, publicRequest ? PUBLIC_CORS_HEADERS : {});
      }
      console.error({ event: "request_failed", error: error.name });
      return json({ error: "service_unavailable" }, 503, publicRequest ? PUBLIC_CORS_HEADERS : {});
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkForDownDevices(env));
  },
};

async function listPublicDevices(env) {
  const ids = [...new Set((env.PUBLIC_DEVICE_IDS || "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 100 || ids.some((id) => !DEVICE_ID_PATTERN.test(id))) {
    throw new Error("Invalid public device allowlist");
  }
  if (!ids.length) return [];
  const result = await getDatabase(env).prepare(
    `SELECT id, name, heartbeat, last_timestamp, last_healthy_timestamp, unavailable_since_timestamp
       FROM devices WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id LIMIT 100`,
  ).bind(...ids).all();
  const now = Date.now();
  return result.results.map((record) => ({
    id: record.id,
    name: record.name,
    heartbeat: publicDeviceRecord(env, record, now).heartbeat,
    last_timestamp: record.last_timestamp,
  }));
}

async function handleHeartbeat(request, env, ctx, url) {
  const body =
    request.method === "POST"
      ? await readJson(request)
      : Object.fromEntries(url.searchParams);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!DEVICE_ID_PATTERN.test(id)) throw new InputError("invalid_id");

  const name = body.name === undefined ? id : body.name;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 128 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new InputError("invalid_name");
  }
  const heartbeat = normalizeHeartbeat(body.heartbeat);
  if (heartbeat === null) throw new InputError("invalid_heartbeat");

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const writeInterval = positiveSeconds(
    env.HEARTBEAT_WRITE_INTERVAL_SECONDS,
    DEFAULT_WRITE_INTERVAL_SECONDS,
  );
  const writeBefore = new Date(
    now - writeInterval * 1000,
  ).toISOString();
  const db = getDatabase(env);

  // The write gate and state transitions run in one statement to avoid stale read/modify/write races.
  const result = await db
    .prepare(
      `INSERT INTO devices (
         id, name, heartbeat, last_timestamp, last_healthy_timestamp, unavailable_since_timestamp
       ) VALUES (?1, ?2, ?3, ?4,
         CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END,
         CASE WHEN ?3 = 0 THEN ?4 ELSE NULL END)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         heartbeat = excluded.heartbeat,
         last_timestamp = excluded.last_timestamp,
         last_healthy_timestamp = CASE WHEN excluded.heartbeat = 1
           THEN excluded.last_timestamp ELSE devices.last_healthy_timestamp END,
         unavailable_since_timestamp = CASE WHEN excluded.heartbeat = 1 THEN NULL
           ELSE COALESCE(devices.unavailable_since_timestamp, excluded.last_timestamp) END,
         alert_sent_at = CASE WHEN excluded.heartbeat = 1 THEN NULL ELSE devices.alert_sent_at END,
         alert_claim_token = CASE WHEN excluded.heartbeat = 1 THEN NULL ELSE devices.alert_claim_token END,
         alert_claim_until = CASE WHEN excluded.heartbeat = 1 THEN NULL ELSE devices.alert_claim_until END,
         alert_retry_at = CASE WHEN excluded.heartbeat = 1 THEN NULL ELSE devices.alert_retry_at END,
         alert_attempts = CASE WHEN excluded.heartbeat = 1 THEN 0 ELSE devices.alert_attempts END
       WHERE devices.last_timestamp <= excluded.last_timestamp
         AND (devices.heartbeat != excluded.heartbeat OR devices.name != excluded.name
           OR devices.last_timestamp <= ?5)
       RETURNING *`,
    )
    .bind(id, name.trim(), heartbeat, nowIso, writeBefore)
    .all();

  const persisted = result.results.length > 0;
  const record = persisted
    ? result.results[0]
    : await db.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first();

  if (heartbeat === 0 && isDevicePastTimeout(env, record, now)) {
    ctx.waitUntil(sendDownAlertOnce(env, id));
  }

  return json({ ok: true, persisted, device: publicDeviceRecord(env, record, now) });
}

async function listDevices(env, url) {
  const after = url.searchParams.get("after") || "";
  const limitText = url.searchParams.get("limit") || "100";
  if (after && !DEVICE_ID_PATTERN.test(after)) throw new InputError("invalid_cursor");
  if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100) {
    throw new InputError("invalid_limit");
  }
  const limit = Number(limitText);
  const result = await getDatabase(env)
    .prepare("SELECT * FROM devices WHERE id > ? ORDER BY id LIMIT ?")
    .bind(after, limit + 1)
    .all();
  const records = result.results.slice(0, limit);
  const headers =
    result.results.length > limit
      ? { "x-next-cursor": records[records.length - 1].id }
      : {};
  const now = Date.now();
  return json(records.map((record) => publicDeviceRecord(env, record, now)), 200, headers);
}

async function checkForDownDevices(env) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const result = await getDatabase(env)
    .prepare(
      `SELECT id FROM devices
        WHERE alert_sent_at IS NULL
          AND ${REFERENCE_TIMESTAMP} < ?1
          AND (alert_retry_at IS NULL OR alert_retry_at <= ?2)
          AND (alert_claim_until IS NULL OR alert_claim_until <= ?2)
        ORDER BY ${REFERENCE_TIMESTAMP}, id
        LIMIT ?3`,
    )
    .bind(timeoutCutoff(env, now), nowIso, ALERT_BATCH_SIZE)
    .all();

  for (const { id } of result.results) {
    await sendDownAlertOnce(env, id);
  }
  console.log({
    event: "down_check",
    candidates: result.results.length,
    rows_read: result.meta.rows_read,
  });
}

async function sendDownAlertOnce(env, id) {
  const db = getDatabase(env);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const claimToken = crypto.randomUUID();
  const result = await db
    .prepare(
      `UPDATE devices SET alert_claim_token = ?1, alert_claim_until = ?2,
         alert_attempts = alert_attempts + 1
       WHERE id = ?3 AND alert_sent_at IS NULL
         AND ${REFERENCE_TIMESTAMP} < ?4
         AND (alert_retry_at IS NULL OR alert_retry_at <= ?5)
         AND (alert_claim_until IS NULL OR alert_claim_until <= ?5)
       RETURNING *`,
    )
    .bind(
      claimToken,
      new Date(now + ALERT_CLAIM_SECONDS * 1000).toISOString(),
      id,
      timeoutCutoff(env, now),
      nowIso,
    )
    .all();
  const device = result.results[0];
  if (!device) return;

  const text =
    "Tunnel/device down\n" +
    `ID: ${device.id}\nName: ${device.name}\n` +
    `Reason: no healthy heartbeat for more than ${positiveSeconds(env.HEARTBEAT_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS)} seconds\n` +
    `Last heartbeat: ${device.last_timestamp}\n` +
    `Last healthy heartbeat: ${device.last_healthy_timestamp || "unknown"}\n` +
    `Unavailable since: ${device.unavailable_since_timestamp || "unknown"}`;
  const delivery = await sendTelegram(env, text);

  // Recovery clears the claim, so a completed old send cannot mark a new outage as alerted.
  if (delivery.ok) {
    await db
      .prepare(
        `UPDATE devices SET alert_sent_at = ?, alert_claim_token = NULL,
           alert_claim_until = NULL, alert_retry_at = NULL
         WHERE id = ? AND alert_claim_token = ?`,
      )
      .bind(new Date().toISOString(), id, claimToken)
      .run();
    console.log({ event: "alert_delivered", id });
    return;
  }

  const backoffSeconds = Math.min(3600, 60 * 2 ** Math.min(device.alert_attempts - 1, 6));
  const retryAt = new Date(
    Date.now() + Math.max(backoffSeconds, delivery.retryAfterSeconds || 0) * 1000,
  ).toISOString();
  await db
    .prepare(
      `UPDATE devices SET alert_claim_token = NULL, alert_claim_until = NULL, alert_retry_at = ?
       WHERE id = ? AND alert_claim_token = ?`,
    )
    .bind(retryAt, id, claimToken)
    .run();
  console.error({ event: "alert_failed", id, error: delivery.error, retry_at: retryAt });
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: "telegram_not_configured" };
  }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok === true) return { ok: true };
    const retryAfter = body?.parameters?.retry_after;
    return {
      ok: false,
      error: `telegram_error_${response.status}`,
      retryAfterSeconds:
        Number.isSafeInteger(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 86400)
          : 0,
    };
  } catch {
    return { ok: false, error: "telegram_network_error" };
  }
}

async function readJson(request) {
  if (!request.body) throw new InputError("invalid_json");
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new InputError("body_too_large", 413);
  }
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new InputError("body_too_large", 413);
    text += decoder.decode(chunk, { stream: true });
  }
  try {
    const body = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("invalid body");
    }
    return body;
  } catch {
    throw new InputError("invalid_json");
  }
}

function authorize(request, secret, header) {
  if (!secret) return json({ error: "service_unconfigured" }, 503);
  if (request.headers.get(header) !== secret) return json({ error: "unauthorized" }, 401);
  return null;
}

function publicDeviceRecord(env, record, now) {
  return {
    id: record.id,
    name: record.name,
    heartbeat: Number(record.heartbeat) === 1 && !isDevicePastTimeout(env, record, now) ? 1 : 0,
    last_timestamp: record.last_timestamp,
    last_healthy_timestamp: record.last_healthy_timestamp,
    unavailable_since_timestamp: record.unavailable_since_timestamp,
    alert_sent_at: record.alert_sent_at,
  };
}

function isDevicePastTimeout(env, record, now) {
  const reference = Date.parse(
    record.last_healthy_timestamp || record.unavailable_since_timestamp || record.last_timestamp,
  );
  return (
    !Number.isFinite(reference) ||
    now - reference > positiveSeconds(env.HEARTBEAT_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS) * 1000
  );
}

function timeoutCutoff(env, now) {
  return new Date(
    now - positiveSeconds(env.HEARTBEAT_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS) * 1000,
  ).toISOString();
}

function positiveSeconds(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeHeartbeat(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().trim();
  if (["1", "true", "up", "ok", "healthy"].includes(normalized)) return 1;
  if (["0", "false", "down", "fail", "unhealthy"].includes(normalized)) return 0;
  return null;
}

function getDatabase(env) {
  if (!env.DB) throw new Error("Missing DB D1 binding");
  return env.DB;
}

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function methodNotAllowed(allow) {
  return json({ error: "method_not_allowed" }, 405, { allow });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
