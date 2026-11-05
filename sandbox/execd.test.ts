import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import test, { after, before } from "node:test";
import { ExecdClient } from "./client.js";

const token = "execd-test-token";
let child: ChildProcessWithoutNullStreams | undefined;
let client: ExecdClient | undefined;
let root = "";
let startFailure = "";

before(async () => {
  root = mkdtempSync(join(tmpdir(), "lilpi-execd-"));
  const python = process.env.PYTHON ?? "python";
  child = spawn(python, [resolve("sandbox/execd/execd.py")], {
    env: {
      ...process.env,
      EXECD_ACCESS_TOKEN: token,
      EXECD_ROOT: root,
      EXECD_PORT: "0",
      EXECD_HOST: "127.0.0.1",
    },
  });

  const port = await new Promise<number | undefined>((resolvePort) => {
    const timer = setTimeout(() => resolvePort(undefined), 10_000);
    const finish = (value: number | undefined): void => {
      clearTimeout(timer);
      resolvePort(value);
    };
    child?.stdout.on("data", (chunk: Buffer) => {
      const match = /execd listening on [^:]+:(\d+)/.exec(chunk.toString());
      if (match) finish(Number(match[1]));
    });
    child?.on("error", (error) => {
      startFailure = `spawn ${python}: ${error.message}`;
      finish(undefined);
    });
    child?.on("exit", (code) => {
      startFailure = `execd exited with ${code}`;
      finish(undefined);
    });
  });

  if (port === undefined) {
    if (!startFailure) startFailure = "execd did not report a port";
    return;
  }
  client = new ExecdClient({ port: 8765, url: `http://127.0.0.1:${port}`, headers: { "X-EXECD-ACCESS-TOKEN": token } });
});

after(() => {
  child?.kill();
  if (root) rmSync(root, { recursive: true, force: true });
});

function requireClient(t: { skip: (reason: string) => void }): ExecdClient {
  if (!client) {
    t.skip(startFailure || "execd not available");
    throw new Error("unreachable");
  }
  return client;
}

test("execd rejects requests without the access token", async (t) => {
  requireClient(t);
  const base = client!.url;
  const unauthorized = await fetch(`${base}/ping`);
  assert.equal(unauthorized.status, 401);
  const wrong = await fetch(`${base}/ping`, { headers: { "X-EXECD-ACCESS-TOKEN": "wrong" } });
  assert.equal(wrong.status, 401);
  const ping = await client!.ping();
  assert.equal(ping.ok, true);
});

test("POST /command streams stdout and reports the exit code", async (t) => {
  const execd = requireClient(t);
  const result = await execd.run("echo hello");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "hello");
});

test("POST /command reports non-zero exit codes", async (t) => {
  const execd = requireClient(t);
  const result = await execd.run("exit 3");
  assert.equal(result.exitCode, 3);
});

test("POST /command kills the process when it times out", async (t) => {
  const execd = requireClient(t);
  const command = process.platform === "win32" ? "ping -n 4 127.0.0.1" : "sleep 3";
  const started = Date.now();
  const result = await execd.run(command, { timeoutMs: 300 });
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 5_000);
});

test("files: write, read back and list the workspace", async (t) => {
  const execd = requireClient(t);
  const written = await execd.writeFile("notes/hello.txt", "written by execd\n");
  assert.equal(written.bytes, 17);
  const file = await execd.readFile("notes/hello.txt");
  assert.equal(file.content, "written by execd\n");
  const listing = await execd.listDirectory(".");
  assert.ok(listing.entries.some((entry) => entry.name === "notes" && entry.type === "directory"));
});

test("files: paths escaping the sandbox root are rejected", async (t) => {
  const execd = requireClient(t);
  await assert.rejects(() => execd.writeFile("../escape.txt", "nope"), /escapes the sandbox root/);
  await assert.rejects(() => execd.readFile("/etc/passwd"), /escapes the sandbox root/);
});
