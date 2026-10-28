import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { smokeTest } from "../scripts/smoke.mjs";
import { createDatabase } from "./helpers/d1.js";

const START = Date.parse("2026-10-28T12:00:00.000Z");
const MINUTE = 60000;

test("the delivery migration preserves existing devices and already-sent alerts", () => {
  const database = createDatabase({ initialOnly: true });
  try {
    const timestamp = new Date(START).toISOString();
    database.sqlite.prepare(
      `INSERT INTO devices (id, name, heartbeat, last_timestamp, last_healthy_timestamp, alert_sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("pi4", "Hermes", 0, timestamp, timestamp, timestamp);
    database.sqlite.exec(readFileSync(
      new URL("../migrations/0002_alert_delivery.sql", import.meta.url), "utf8",
    ));
    const row = database.sqlite.prepare("SELECT * FROM devices WHERE id = ?").get("pi4");
    assert.equal(row.last_healthy_timestamp, timestamp);
    assert.equal(row.alert_sent_at, timestamp);
    assert.equal(row.alert_attempts, 0);
    assert.equal(row.alert_claim_token, null);
  } finally {
    database.sqlite.close();
  }
});

function harness(t) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const database = createDatabase();
  t.after(() => database.sqlite.close());
  const env = {
    DB: database,
    HEARTBEAT_TOKEN: "heartbeat-test-token",
    STATUS_TOKEN: "status-test-token",
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
    TELEGRAM_CHAT_ID: "123",
    HEARTBEAT_TIMEOUT_SECONDS: "1800",
    HEARTBEAT_WRITE_INTERVAL_SECONDS: "300",
  };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const telegram = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: true, result: { message_id: 1 } }),
  );
  const request = (path, init = {}) =>
    worker.fetch(new Request(new URL(path, "https://monitor.example"), init), env, ctx);
  const flush = async () => Promise.all(pending.splice(0));
  return {
    env, database, request, telegram, ctx, flush,
    tick(milliseconds) { t.mock.timers.tick(milliseconds); },
    row(id = "pi4") { return database.sqlite.prepare("SELECT * FROM devices WHERE id = ?").get(id); },
    async beat(heartbeat = 1, id = "pi4", name = id) {
      const response = await request("/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-heartbeat-token": env.HEARTBEAT_TOKEN },
        body: JSON.stringify({ id, name, heartbeat }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    async scan() {
      await worker.scheduled({}, env, ctx);
      await flush();
    },
    status(path = "/status") {
      return request(path, { headers: { "x-status-token": env.STATUS_TOKEN } });
    },
  };
}

test("healthy reports persist at five minutes, while state changes persist immediately", async (t) => {
  const h = harness(t);
  assert.equal((await h.beat()).persisted, true);
  for (let minute = 1; minute < 5; minute++) {
    h.tick(MINUTE);
    assert.equal((await h.beat()).persisted, false);
  }
  assert.equal(h.row().last_healthy_timestamp, new Date(START).toISOString());
  h.tick(MINUTE);
  assert.equal((await h.beat()).persisted, true);
  h.tick(1);
  assert.equal((await h.beat(0)).persisted, true);
  assert.equal(h.row().heartbeat, 0);
  h.tick(1);
  assert.equal((await h.beat(1)).persisted, true);
  assert.equal(h.row().unavailable_since_timestamp, null);
  await h.flush();
});

test("no alert before or exactly at 30 minutes; one alert strictly after it", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(30 * MINUTE - 1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 0);
  h.tick(1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 0);
  h.tick(1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
  assert(h.row().alert_sent_at);
  await h.scan();
  await h.beat(0);
  await h.flush();
  assert.equal(h.telegram.mock.callCount(), 1);
});

test("unhealthy reports never move the last healthy time or postpone the outage", async (t) => {
  const h = harness(t);
  await h.beat();
  for (let minute = 5; minute <= 30; minute += 5) {
    h.tick(5 * MINUTE);
    await h.beat(0);
    await h.flush();
  }
  assert.equal(h.row().last_healthy_timestamp, new Date(START).toISOString());
  assert.equal(h.row().unavailable_since_timestamp, new Date(START + 5 * MINUTE).toISOString());
  assert.equal(h.telegram.mock.callCount(), 0);
  h.tick(1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
});

test("a device first seen unhealthy gets a full 30-minute grace period", async (t) => {
  const h = harness(t);
  await h.beat(0);
  const firstUnavailable = h.row().unavailable_since_timestamp;
  h.tick(20 * MINUTE);
  await h.beat(0);
  await h.flush();
  assert.equal(h.row().unavailable_since_timestamp, firstUnavailable);
  h.tick(10 * MINUTE);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 0);
  h.tick(1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
});

test("recovery resets alert state and allows one alert for the next outage", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
  await h.beat();
  assert.equal(h.row().alert_sent_at, null);
  assert.equal(h.row().alert_attempts, 0);
  h.tick(30 * MINUTE + 1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 2);
});

test("Telegram HTTP/API failures stay unsent and retry with exponential backoff", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  h.telegram.mock.mockImplementation(async () => Response.json({ ok: false }, { status: 500 }));
  await h.scan();
  assert.equal(h.row().alert_sent_at, null);
  assert.equal(h.row().alert_claim_token, null);
  assert.equal(h.row().alert_attempts, 1);
  assert.equal(Date.parse(h.row().alert_retry_at), Date.now() + MINUTE);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
  h.tick(MINUTE);
  h.telegram.mock.mockImplementation(async () => Response.json({ ok: false }));
  await h.scan();
  assert.equal(h.row().alert_attempts, 2);
  assert.equal(Date.parse(h.row().alert_retry_at), Date.now() + 2 * MINUTE);
  h.tick(2 * MINUTE);
  h.telegram.mock.mockImplementation(async () => Response.json({ ok: true }));
  await h.scan();
  assert(h.row().alert_sent_at);
  assert.equal(h.telegram.mock.callCount(), 3);
});

test("Telegram flood control honors retry_after instead of immediately retrying", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  h.telegram.mock.mockImplementation(async () =>
    Response.json({ ok: false, parameters: { retry_after: 900 } }, { status: 429 }),
  );
  await h.scan();
  assert.equal(Date.parse(h.row().alert_retry_at), Date.now() + 15 * MINUTE);
  h.tick(15 * MINUTE - 1);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
  h.tick(1);
  h.telegram.mock.mockImplementation(async () => Response.json({ ok: true }));
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 2);
});

test("missing credentials, network errors, and invalid Telegram JSON do not suppress alerts", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  delete h.env.TELEGRAM_BOT_TOKEN;
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 0);
  assert.equal(h.row().alert_sent_at, null);
  h.env.TELEGRAM_BOT_TOKEN = "restored-token";
  h.tick(MINUTE);
  h.telegram.mock.mockImplementation(async () => { throw new Error("network failed"); });
  await h.scan();
  assert.equal(h.row().alert_sent_at, null);
  h.tick(2 * MINUTE);
  h.telegram.mock.mockImplementation(async () => new Response("not JSON"));
  await h.scan();
  assert.equal(h.row().alert_sent_at, null);
  h.tick(4 * MINUTE);
  h.telegram.mock.mockImplementation(async () => Response.json({ ok: true }));
  await h.scan();
  assert(h.row().alert_sent_at);
});

test("overlapping cron and heartbeat checks claim only one Telegram send", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  await Promise.all([
    worker.scheduled({}, h.env, h.ctx),
    worker.scheduled({}, h.env, h.ctx),
    h.beat(0),
  ]);
  await h.flush();
  assert.equal(h.telegram.mock.callCount(), 1);
  assert.equal(h.row().alert_attempts, 1);
});

test("abandoned alert claims expire and can be retried", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  h.database.sqlite.prepare(
    "UPDATE devices SET alert_claim_token = ?, alert_claim_until = ? WHERE id = ?",
  ).run("crashed-worker", new Date(Date.now() + 2 * MINUTE).toISOString(), "pi4");
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 0);
  h.tick(2 * MINUTE);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 1);
  assert(h.row().alert_sent_at);
});

test("an in-flight old delivery cannot mark a recovered device's new outage as sent", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(31 * MINUTE);
  const started = Promise.withResolvers();
  const delivery = Promise.withResolvers();
  h.telegram.mock.mockImplementation(async () => {
    started.resolve();
    await delivery.promise;
    return Response.json({ ok: true });
  });
  const scan = h.scan();
  await started.promise;
  try {
    await h.beat();
    h.tick(MINUTE);
    await h.beat(0);
  } finally {
    delivery.resolve();
  }
  await scan;
  await h.flush();
  assert.equal(h.row().heartbeat, 0);
  assert.equal(h.row().alert_sent_at, null);
  h.tick(30 * MINUTE);
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 2);
});

test("a delayed older heartbeat cannot overwrite a newer persisted heartbeat", async (t) => {
  const h = harness(t);
  await h.beat();
  h.tick(5 * MINUTE);
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  h.database.beforeQuery = async (sql, bindings) => {
    if (sql.includes("INSERT INTO devices") && bindings[2] === 0) {
      started.resolve();
      await resume.promise;
    }
  };
  const older = h.beat(0);
  await started.promise;
  try {
    h.tick(MINUTE);
    await h.beat(1);
  } finally {
    resume.resolve();
  }
  assert.equal((await older).persisted, false);
  assert.equal(h.row().heartbeat, 1);
  assert.equal(h.row().last_timestamp, new Date(START + 6 * MINUTE).toISOString());
  await h.flush();
});

test("cron uses the pending-alert index, skips fresh devices, and bounds each batch", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 12; index++) await h.beat(1, `old-${index}`);
  h.tick(31 * MINUTE);
  await h.beat(1, "fresh");
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 10);
  const query = h.database.queries.find(({ sql }) => sql.includes("SELECT id FROM devices"));
  const plan = await h.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.bindings).all();
  assert(plan.results.some(({ detail }) => detail.includes("USING INDEX idx_devices_pending_alerts")));
  await h.scan();
  assert.equal(h.telegram.mock.callCount(), 12);
  assert.equal(h.row("fresh").alert_sent_at, null);
});

test("status is authenticated, paginated, and hides private delivery fields", async (t) => {
  const h = harness(t);
  for (const id of ["a", "b", "c"]) await h.beat(1, id);
  const first = await h.status("/status?limit=2");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-next-cursor"), "b");
  const records = await first.json();
  assert.deepEqual(records.map(({ id }) => id), ["a", "b"]);
  assert(!Object.hasOwn(records[0], "alert_claim_token"));
  const second = await h.status("/status?limit=2&after=b");
  assert.equal(second.headers.get("x-next-cursor"), null);
  assert.deepEqual((await second.json()).map(({ id }) => id), ["c"]);
  h.tick(30 * MINUTE + 1);
  const stale = await h.status("/status?limit=1");
  assert.equal((await stale.json())[0].heartbeat, 0);
});

test("authentication rejects URL tokens and separates read/write access before D1", async (t) => {
  const h = harness(t);
  const cases = [
    ["/status", {}],
    ["/", {}],
    ["/health", {}],
    ["/status", { headers: { "x-heartbeat-token": h.env.HEARTBEAT_TOKEN } }],
    ["/heartbeat?id=pi4&heartbeat=1", { headers: { "x-status-token": h.env.STATUS_TOKEN } }],
    [`/heartbeat?id=pi4&heartbeat=1&token=${h.env.HEARTBEAT_TOKEN}`, {}],
  ];
  for (const [path, init] of cases) assert.equal((await h.request(path, init)).status, 401);
  assert.equal(h.database.queries.length, 0);
  delete h.env.STATUS_TOKEN;
  assert.equal((await h.status()).status, 503);
});

test("invalid JSON, IDs, names, states, and oversized bodies do not touch D1", async (t) => {
  const h = harness(t);
  const invalid = [
    "{", "null", "[]", '"text"',
    ...[
      { heartbeat: 1 },
      { id: "a".repeat(65), heartbeat: 1 },
      { id: "bad id", heartbeat: 1 },
      { id: "pi4" },
      { id: "pi4", heartbeat: null },
      { id: "pi4", heartbeat: "garbage" },
      { id: "pi4", heartbeat: {} },
      { id: "pi4", heartbeat: 1, name: [] },
      { id: "pi4", heartbeat: 1, name: " " },
      { id: "pi4", heartbeat: 1, name: "bad\nname" },
      { id: "pi4", heartbeat: 1, name: "a".repeat(129) },
    ].map((body) => JSON.stringify(body)),
  ];
  for (const body of invalid) {
    const response = await h.request("/heartbeat", {
      method: "POST", headers: { "x-heartbeat-token": h.env.HEARTBEAT_TOKEN }, body,
    });
    assert.equal(response.status, 400, body);
  }
  const oversized = await h.request("/heartbeat", {
    method: "POST", headers: { "x-heartbeat-token": h.env.HEARTBEAT_TOKEN },
    body: JSON.stringify({ id: "pi4", heartbeat: 1, padding: "x".repeat(4096) }),
  });
  assert.equal(oversized.status, 413);
  for (const query of ["limit=0", "limit=101", "limit=1.5", "after=bad%20id"]) {
    assert.equal((await h.status(`/status?${query}`)).status, 400);
  }
  assert.equal(h.database.queries.length, 0);
});

test("GET heartbeats require header authentication and validate explicit state", async (t) => {
  const h = harness(t);
  const response = await h.request("/heartbeat?id=pi4&name=Hermes&heartbeat=healthy", {
    headers: { "x-heartbeat-token": h.env.HEARTBEAT_TOKEN },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).device.heartbeat, 1);
  const invalid = await h.request("/heartbeat?id=pi4&heartbeat=maybe", {
    headers: { "x-heartbeat-token": h.env.HEARTBEAT_TOKEN },
  });
  assert.equal(invalid.status, 400);
  const method = await h.request("/heartbeat", { method: "DELETE" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, POST");
  assert.equal((await h.request("/unknown")).status, 404);
});

test("deployment smoke checks authentication and migrated D1 without changing device state", async (t) => {
  const h = harness(t);
  await h.beat();
  const before = { ...h.row() };
  const fetcher = (url, init) => h.request(String(url), init);
  await smokeTest("https://monitor.example", h.env.STATUS_TOKEN, fetcher);
  assert.deepEqual({ ...h.row() }, before);
  await assert.rejects(smokeTest("https://monitor.example", "wrong-token", fetcher));
  const unmigrated = createDatabase({ initialOnly: true });
  t.after(() => unmigrated.sqlite.close());
  h.env.DB = unmigrated;
  await assert.rejects(
    smokeTest("https://monitor.example", h.env.STATUS_TOKEN, fetcher),
    /D1 schema\/binding health check failed/,
  );
});
