import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { ExecdClient } from "./client.js";
import { DockerRuntime } from "./docker-runtime.js";
import { MemoryMetadataStore } from "./metadata.js";
import { LifecycleService } from "./service.js";

const runtime = new DockerRuntime({ execdDir: resolve("sandbox/execd") });
const dockerAvailable = await runtime.available();

test(
  "docker runtime: create, exec over execd, pause, resume, delete",
  { skip: dockerAvailable ? false : "Docker daemon is not reachable", timeout: 240_000 },
  async () => {
    const service = new LifecycleService({
      runtime,
      metadata: new MemoryMetadataStore(),
      defaultImage: process.env.SANDBOX_IMAGE ?? "python:3.12-slim",
      execdCommand: ["python3", "/opt/execd/execd.py"],
      defaultTtlSeconds: 180,
      ttlSweepMs: 60_000,
    });
    let id: string | undefined;
    try {
      const created = await service.create({ ttlSeconds: 180 });
      id = created.id;
      assert.equal(created.state, "Pending");

      const ready = await service.waitReady(created.id, 180_000);
      assert.equal(ready.state, "Running");

      const endpoint = await service.getEndpoint(created.id, created.execdPort);
      const execd = new ExecdClient(endpoint);
      assert.equal((await execd.ping()).ok, true);

      const echo = await execd.run("echo hello-docker");
      assert.equal(echo.exitCode, 0);
      assert.equal(echo.stdout.trim(), "hello-docker");

      const paused = await service.pause(created.id);
      assert.equal(paused.state, "Paused");
      assert.equal(paused.expiresAt, created.expiresAt);

      const resumed = await service.resume(created.id);
      assert.equal(resumed.state, "Running");
      const again = await execd.run("echo resumed");
      assert.equal(again.stdout.trim(), "resumed");

      await service.delete(created.id);
      id = undefined;
      assert.equal(await service.get(created.id), undefined);
    } finally {
      if (id) await service.delete(id).catch(() => undefined);
      service.close();
    }
  },
);
