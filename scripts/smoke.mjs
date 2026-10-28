import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function smokeTest(baseUrl, statusToken, fetcher = fetch) {
  assert(baseUrl, "Set CF_WORKER_URL");
  assert(statusToken, "Set STATUS_TOKEN");
  const base = new URL(baseUrl);
  assert(
    base.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname),
    "Use HTTPS for remote smoke tests",
  );
  const options = () => ({
    headers: { "x-status-token": statusToken },
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });

  const denied = await fetcher(new URL("/status", base), {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  assert.equal(denied.status, 401, "Status must require authentication");
  await denied.body?.cancel();

  const health = await fetcher(new URL("/health", base), options());
  assert.equal(health.status, 200, "D1 schema/binding health check failed");
  assert.deepEqual(await health.json(), { ok: true, database: "ok" });

  const status = await fetcher(new URL("/status?limit=1", base), options());
  assert.equal(status.status, 200, "Authenticated status request failed");
  assert(Array.isArray(await status.json()), "Status response must be an array");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await smokeTest(process.env.CF_WORKER_URL, process.env.STATUS_TOKEN);
    console.log("Smoke test passed: authentication, D1 schema/binding, and status reads");
  } catch (error) {
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = 1;
  }
}
