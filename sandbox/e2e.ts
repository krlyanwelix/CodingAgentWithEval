/**
 * End-to-end example: create -> exec (streamed) -> pause -> resume -> delete.
 *
 * Self-contained: starts the control plane in-process on an ephemeral port and
 * uses the real Docker runtime. Requires a running Docker daemon and the
 * codingagentwitheval-sandbox:local image (`npm run sandbox:image`).
 *
 *   npm run sandbox:e2e
 */
import "dotenv/config";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ControlPlaneClient, ExecdClient } from "./client.js";
import { createControlPlane } from "./control-plane.js";
import { DockerRuntime } from "./docker-runtime.js";
import { MemoryMetadataStore } from "./metadata.js";
import { LifecycleService } from "./service.js";

const started = Date.now();
const stamp = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const runtime = new DockerRuntime();
  if (!(await runtime.available())) {
    console.error("Docker daemon is not reachable (start Docker Desktop first).");
    process.exit(1);
  }

  const service = new LifecycleService({
    runtime,
    metadata: new MemoryMetadataStore(),
    defaultImage: process.env.SANDBOX_IMAGE ?? "codingagentwitheval-sandbox:local",
    defaultTtlSeconds: 180,
    ttlSweepMs: 60_000,
  });
  const server = createControlPlane(service);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  const client = new ControlPlaneClient({ baseUrl: `http://127.0.0.1:${port}` });
  console.log(`[${stamp()}] control plane on ${client.baseUrl}`);

  let sandboxId: string | undefined;
  try {
    // 1. Async create: the API answers with Pending, not a running sandbox.
    const created = await client.create({ ttlSeconds: 180 });
    sandboxId = created.id;
    assert.equal(created.state, "Pending");
    console.log(`[${stamp()}] create -> ${created.id} ${created.state} expires ${created.expiresAt}`);

    // 2. Readiness helper (polling is also fine).
    const ready = await client.waitReady(created.id, 120_000);
    assert.equal(ready.state, "Running");
    console.log(`[${stamp()}] ready -> ${ready.state}`);

    // 3. Endpoint resolution is the only sanctioned way in.
    const endpoint = await client.endpoint(created.id, created.execdPort);
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const execd = new ExecdClient(endpoint);
    assert.equal((await execd.ping()).ok, true);
    console.log(`[${stamp()}] execd ping -> ${endpoint.url}`);

    // 4. Streamed command output over SSE.
    const hello = await execd.run("echo hello", {
      timeoutMs: 15_000,
      onEvent: (event) => {
        if (event.type === "stdout") process.stdout.write(`  stream: ${event.chunk}`);
      },
    });
    assert.equal(hello.exitCode, 0);
    assert.equal(hello.stdout.trim(), "hello");
    console.log(`[${stamp()}] exec echo hello -> exit ${hello.exitCode}`);

    // 5. Data-plane file operations.
    await execd.writeFile("/workspace/hello.txt", "written by execd\n");
    const file = await execd.readFile("/workspace/hello.txt");
    assert.equal(file.content, "written by execd\n");
    const listing = await execd.listDirectory("/workspace");
    assert.ok(listing.entries.some((entry) => entry.name === "hello.txt"));
    console.log(`[${stamp()}] files -> ${listing.entries.map((entry) => entry.name).join(", ")}`);

    // 6. Pause freezes the sandbox; the absolute TTL does not move.
    const paused = await client.pause(created.id);
    assert.equal(paused.state, "Paused");
    assert.equal(paused.expiresAt, created.expiresAt);
    console.log(`[${stamp()}] pause -> ${paused.state} expires ${paused.expiresAt} (unchanged)`);

    // 7. Resume only works from Paused; it is not a restart.
    const resumed = await client.resume(created.id);
    assert.equal(resumed.state, "Running");
    const again = await execd.run("echo resumed");
    assert.equal(again.stdout.trim(), "resumed");
    console.log(`[${stamp()}] resume -> ${resumed.state}, exec echo resumed -> ${again.stdout.trim()}`);

    // 8. Destroy. The record is gone afterwards.
    await client.delete(created.id);
    assert.equal(await client.get(created.id), undefined);
    sandboxId = undefined;
    console.log(`[${stamp()}] delete -> gone`);
  } finally {
    if (sandboxId) {
      await client.delete(sandboxId).catch(() => undefined);
    }
    service.close();
    server.close();
  }
  console.log(`[${stamp()}] e2e finished`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
