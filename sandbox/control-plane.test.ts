import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { createControlPlane } from "./control-plane.js";
import { FakeRuntime } from "./fake-runtime.js";
import { MemoryMetadataStore } from "./metadata.js";
import { LifecycleService } from "./service.js";

const runtime = new FakeRuntime();
runtime.startDelayMs = 40;
const service = new LifecycleService({
  runtime,
  metadata: new MemoryMetadataStore(),
  ttlSweepMs: 60_000,
  dataPlaneProbe: async () => true,
});
const server = createControlPlane(service);
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  service.close();
  server.close();
});

interface CallResult {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function call(method: string, path: string, payload?: unknown): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

async function waitRunning(id: string): Promise<void> {
  const ready = await call("GET", `/sandboxes/${id}/ready?timeoutMs=5000`);
  assert.equal(ready.status, 200);
  assert.equal((ready.body?.sandbox as { state: string }).state, "Running");
}

test("POST /sandboxes answers 202 Pending, then ready reports Running", async () => {
  const created = await call("POST", "/sandboxes", { ttlSeconds: 60 });
  assert.equal(created.status, 202);
  const sandbox = created.body?.sandbox as { id: string; state: string };
  assert.equal(sandbox.state, "Pending");

  await waitRunning(sandbox.id);
  const got = await call("GET", `/sandboxes/${sandbox.id}`);
  assert.equal(got.status, 200);
  assert.equal((got.body?.sandbox as { state: string }).state, "Running");

  const list = await call("GET", "/sandboxes");
  assert.equal(list.status, 200);
  assert.ok((list.body?.sandboxes as Array<{ id: string }>).some((item) => item.id === sandbox.id));

  await call("DELETE", `/sandboxes/${sandbox.id}`);
});

test("endpoints carry the execd token, pause/resume obey the state machine", async () => {
  const created = await call("POST", "/sandboxes", {});
  const id = (created.body?.sandbox as { id: string }).id;
  await waitRunning(id);

  const endpoint = await call("GET", `/sandboxes/${id}/endpoints/8765`);
  assert.equal(endpoint.status, 200);
  const resolved = endpoint.body?.endpoint as { url: string; headers?: Record<string, string> };
  assert.equal(resolved.url, "http://127.0.0.1:40123");
  assert.ok(resolved.headers?.["X-EXECD-ACCESS-TOKEN"]);

  const paused = await call("POST", `/sandboxes/${id}/pause`);
  assert.equal(paused.status, 200);
  assert.equal((paused.body?.sandbox as { state: string }).state, "Paused");

  const resumed = await call("POST", `/sandboxes/${id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal((resumed.body?.sandbox as { state: string }).state, "Running");

  const again = await call("POST", `/sandboxes/${id}/resume`);
  assert.equal(again.status, 409);

  await call("DELETE", `/sandboxes/${id}`);
});

test("delete removes the sandbox; unknown ids are 404", async () => {
  const created = await call("POST", "/sandboxes", {});
  const id = (created.body?.sandbox as { id: string }).id;
  await waitRunning(id);

  assert.equal((await call("DELETE", `/sandboxes/${id}`)).status, 204);
  assert.equal((await call("GET", `/sandboxes/${id}`)).status, 404);
  assert.equal((await call("POST", `/sandboxes/${id}/pause`)).status, 404);
  assert.equal((await call("GET", `/sandboxes/${id}/endpoints/8765`)).status, 404);
});

test("invalid input and unknown routes are rejected with JSON errors", async () => {
  const badJson = await fetch(`${base}/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(badJson.status, 400);
  const parsed = (await badJson.json()) as { error: { code: string } };
  assert.equal(parsed.error.code, "invalid");

  assert.equal((await call("POST", "/sandboxes", { ttlSeconds: -5 })).status, 400);
  assert.equal((await call("GET", "/nope")).status, 404);
  assert.equal((await call("GET", "/healthz")).status, 200);
});
