import assert from "node:assert/strict";
import test from "node:test";
import { FakeRuntime } from "./fake-runtime.js";
import { MemoryMetadataStore } from "./metadata.js";
import { LifecycleService } from "./service.js";
import { SandboxError } from "./types.js";

function makeService(runtime = new FakeRuntime()): {
  service: LifecycleService;
  runtime: FakeRuntime;
  metadata: MemoryMetadataStore;
} {
  const metadata = new MemoryMetadataStore();
  const service = new LifecycleService({
    runtime,
    metadata,
    ttlSweepMs: 20,
    dataPlaneProbe: async () => true,
  });
  return { service, runtime, metadata };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("create answers Pending and becomes Running in the background", async () => {
  const { service, runtime } = makeService();
  runtime.startDelayMs = 40;
  try {
    const created = await service.create({ ttlSeconds: 60 });
    assert.equal(created.state, "Pending");

    const ready = await service.waitReady(created.id, 2_000);
    assert.equal(ready.state, "Running");
    assert.equal((await service.get(created.id))?.state, "Running");
  } finally {
    service.close();
  }
});

test("a backend failure ends in Failed, and waitReady rejects", async () => {
  const { service, runtime } = makeService();
  runtime.failWith = "image does not exist";
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await assert.rejects(
      () => service.waitReady(created.id, 2_000),
      (error: unknown) => error instanceof SandboxError && /image does not exist/.test(error.message),
    );
    const snapshot = await service.get(created.id);
    assert.equal(snapshot?.state, "Failed");
    assert.match(snapshot?.error ?? "", /image does not exist/);
  } finally {
    service.close();
  }
});

test("resume only leaves Paused; Running and Terminated are rejected", async () => {
  const { service } = makeService();
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await service.waitReady(created.id, 2_000);

    await assert.rejects(
      () => service.resume(created.id),
      (error: unknown) => error instanceof SandboxError && error.code === "conflict" && /only a Paused/.test(error.message),
    );

    const paused = await service.pause(created.id);
    assert.equal(paused.state, "Paused");
    const resumed = await service.resume(created.id);
    assert.equal(resumed.state, "Running");
  } finally {
    service.close();
  }
});

test("pause requires Running", async () => {
  const { service, runtime } = makeService();
  runtime.startDelayMs = 200;
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await assert.rejects(
      () => service.pause(created.id),
      (error: unknown) => error instanceof SandboxError && error.code === "conflict" && /is Pending/.test(error.message),
    );
  } finally {
    service.close();
  }
});

test("expired sandboxes are terminated and cannot be resumed", async () => {
  const { service, runtime } = makeService();
  try {
    const created = await service.create({ ttlSeconds: 0.15 });
    await waitFor(async () => (await service.get(created.id))?.state === "Terminated");
    const expired = await service.get(created.id);
    assert.match(expired?.error ?? "", /expired/);
    assert.ok(runtime.deleted.includes(created.id));

    await assert.rejects(
      () => service.resume(created.id),
      (error: unknown) => error instanceof SandboxError && /replacement/.test(error.message),
    );
  } finally {
    service.close();
  }
});

test("TTL is absolute: pause and resume never reset the deadline", async () => {
  const { service } = makeService();
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await service.waitReady(created.id, 2_000);
    const paused = await service.pause(created.id);
    assert.equal(paused.expiresAt, created.expiresAt);
    const resumed = await service.resume(created.id);
    assert.equal(resumed.expiresAt, created.expiresAt);
  } finally {
    service.close();
  }
});

test("endpoints resolve only while Running and carry the execd token", async () => {
  const { service } = makeService();
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await service.waitReady(created.id, 2_000);
    const endpoint = await service.getEndpoint(created.id, created.execdPort);
    assert.equal(endpoint.url, "http://127.0.0.1:40123");
    assert.ok(endpoint.headers?.["X-EXECD-ACCESS-TOKEN"]);

    await service.pause(created.id);
    await assert.rejects(
      () => service.getEndpoint(created.id, created.execdPort),
      (error: unknown) => error instanceof SandboxError && error.code === "conflict",
    );
  } finally {
    service.close();
  }
});

test("metadata is disposable: records are rebuilt from the backend", async () => {
  const { service, metadata, runtime } = makeService();
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await service.waitReady(created.id, 2_000);
    const record = metadata.get(created.id);
    assert.ok(record);

    metadata.delete(created.id);
    const rebuilt = await service.get(created.id);
    assert.equal(rebuilt?.state, "Running");
    assert.equal(rebuilt?.expiresAt, new Date(record.expiresAt).toISOString());
    const endpoint = await service.getEndpoint(created.id, created.execdPort);
    assert.equal(endpoint.headers?.["X-EXECD-ACCESS-TOKEN"], runtime.containers.get(created.id)?.token);
  } finally {
    service.close();
  }
});

test("list adopts workloads that exist only in the backend", async () => {
  const { service, runtime } = makeService();
  runtime.containers.set("sbx-orphan", {
    id: "sbx-orphan",
    phase: "running",
    token: "orphan-token",
    image: "lilpi-sandbox:local",
    labels: {
      "lilpi.sandbox.created": String(Date.now()),
      "lilpi.sandbox.expires": String(Date.now() + 60_000),
    },
  });
  try {
    const sandboxes = await service.list();
    const orphan = sandboxes.find((sandbox) => sandbox.id === "sbx-orphan");
    assert.equal(orphan?.state, "Running");
  } finally {
    service.close();
  }
});

test("delete removes the record and the workload", async () => {
  const { service, runtime } = makeService();
  try {
    const created = await service.create({ ttlSeconds: 60 });
    await service.waitReady(created.id, 2_000);
    await service.delete(created.id);
    assert.equal(await service.get(created.id), undefined);
    assert.ok(runtime.deleted.includes(created.id));
    await assert.rejects(
      () => service.delete(created.id),
      (error: unknown) => error instanceof SandboxError && error.code === "not_found",
    );
  } finally {
    service.close();
  }
});
