import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("../src/heartbeat.sh", import.meta.url));

function runClient(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "heartbeat-client-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "calls.jsonl");
  writeFileSync(callsPath, "");
  for (const tool of ["curl", "systemctl", "tailscale"]) {
    writeFileSync(join(directory, tool), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ tool: ${JSON.stringify(tool)}, args }) + "\\n");
if (${JSON.stringify(tool)} === "systemctl") process.exit(Number(process.env.MOCK_SERVICE_EXIT || 0));
if (${JSON.stringify(tool)} === "tailscale") {
  process.stdout.write(JSON.stringify({ BackendState: process.env.MOCK_TAILSCALE_STATE || "Running" }));
  process.exit(0);
}
if (args.includes("--data")) {
  process.stdout.write(process.env.MOCK_POST_BODY || '{"ok":true,"persisted":true}');
  process.exit(Number(process.env.MOCK_POST_EXIT || 0));
}
process.stdout.write(process.env.MOCK_HEALTH_STATUS || "200");
process.exit(Number(process.env.MOCK_HEALTH_EXIT || 0));
`, { mode: 0o755 });
  }
  const result = spawnSync("bash", [client], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CF_WORKER_URL: "https://monitor.example/",
      HEARTBEAT_TOKEN: "client-test-token",
      HEARTBEAT_DEVICE_ID: "pi4",
      HEARTBEAT_DEVICE_NAME: 'Hermes "Pi" \\ office',
      HEALTHCHECK_URL: "https://tunnel.example/healthz",
      CLOUDFLARED_SERVICE: "cloudflared",
      MOCK_CALLS: callsPath,
      ...overrides,
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const post = calls.find(({ tool, args }) => tool === "curl" && args.includes("--data"));
  const payload = post ? JSON.parse(post.args[post.args.indexOf("--data") + 1]) : null;
  return { ...result, calls, post, payload };
}

test("client probes the actual tunnel and safely encodes names with bounded curl requests", (t) => {
  const result = runClient(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.payload, { id: "pi4", name: 'Hermes "Pi" \\ office', heartbeat: 1 });
  assert.equal(result.calls.length, 3);
  for (const { args } of result.calls.filter(({ tool }) => tool === "curl")) {
    assert(args.includes("--connect-timeout"));
    assert(args.includes("--max-time"));
    assert(args.includes("--retry"));
    assert(args.includes("--retry-max-time"));
  }
  assert.equal(result.post.args.at(-1), "https://monitor.example/heartbeat");
  assert(result.post.args.includes("x-heartbeat-token: client-test-token"));
});

test("an inactive service sends unhealthy without running the HTTP health probe", (t) => {
  const result = runClient(t, { MOCK_SERVICE_EXIT: "3" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.payload.heartbeat, 0);
  assert.equal(result.calls.length, 2);
});

test("an active process with a failing tunnel HTTP probe sends unhealthy", (t) => {
  const result = runClient(t, { MOCK_HEALTH_EXIT: "22", MOCK_HEALTH_STATUS: "503" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.payload.heartbeat, 0);
});

test("a non-2xx final response cannot be reported as a healthy tunnel", (t) => {
  const result = runClient(t, { MOCK_HEALTH_STATUS: "302" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.payload.heartbeat, 0);
});

test("delivery errors fail the service for journal visibility", (t) => {
  const result = runClient(t, { MOCK_POST_EXIT: "7" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Heartbeat delivery failed/);
});

test("an unsuccessful Worker JSON response fails the client", (t) => {
  const result = runClient(t, { MOCK_POST_BODY: '{"ok":false}' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected heartbeat response/);
});

test("missing health URL and insecure endpoints fail before sending credentials", (t) => {
  const missing = runClient(t, { HEALTHCHECK_URL: "" });
  assert.equal(missing.status, 1);
  assert.equal(missing.calls.length, 0);
  const insecure = runClient(t, { CF_WORKER_URL: "http://monitor.example" });
  assert.equal(insecure.status, 1);
  assert.equal(insecure.calls.length, 0);
});

test("service-only mode needs no HTTP endpoint and checks all required services", (t) => {
  const result = runClient(t, { HEALTHCHECK_MODE: "services", HEALTHCHECK_URL: "", HEARTBEAT_SERVICES: "cloudflared ssh" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.payload.heartbeat, 1);
  assert.equal(result.calls.filter(c => c.tool === "systemctl").length, 2);
  assert.equal(result.calls.filter(c => c.tool === "curl").length, 1);
});

test("Tailscale mode distinguishes an active daemon from an expired or missing login", (t) => {
  for (const state of ["Running", "NeedsLogin", "Stopped"]) {
    const result = runClient(t, { HEALTHCHECK_MODE: "tailscale", HEALTHCHECK_URL: "", MOCK_TAILSCALE_STATE: state });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.payload.heartbeat, state === "Running" ? 1 : 0);
    assert(result.calls.some(c => c.tool === "tailscale"));
  }
});

test("unknown probe modes fail closed before sending a heartbeat", (t) => {
  const result = runClient(t, { HEALTHCHECK_MODE: "unknown" });
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 0);
});
