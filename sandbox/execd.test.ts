/**
 * Data-plane protocol tests against the real runtime image.
 *
 * The Go execd runs inside the container — that is the shipping shape, so the
 * tests exercise exactly what the sandbox uses. Requires Docker and the
 * lilpi-sandbox:local image (`npm run sandbox:image`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import test, { after, before } from "node:test";
import { ExecdClient } from "./client.js";

const execFileAsync = promisify(execFile);
const token = "execd-test-token";
const image = process.env.SANDBOX_IMAGE ?? "lilpi-sandbox:local";
const container = `lilpi-execd-test-${process.pid}`;
let client: ExecdClient | undefined;
let startFailure = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: timeoutMs, windowsHide: true });
  return stdout.trim();
}

before(async () => {
  try {
    await docker(["image", "inspect", image], 30_000);
  } catch {
    startFailure = `image ${image} is missing; build it with: npm run sandbox:image`;
    return;
  }
  try {
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      "127.0.0.1::8765",
      "-e",
      `EXECD_ACCESS_TOKEN=${token}`,
      image,
    ]);
  } catch (error) {
    startFailure = `docker run failed: ${String(error)}`;
    return;
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const mapping = await docker(["port", container, "8765/tcp"], 15_000).catch(() => "");
    const port = /:(\d+)\s*$/m.exec(mapping ?? "")?.[1];
    if (port) {
      const candidate = new ExecdClient({
        port: 8765,
        url: `http://127.0.0.1:${port}`,
        headers: { "X-EXECD-ACCESS-TOKEN": token },
      });
      try {
        if ((await candidate.ping()).ok) {
          client = candidate;
          return;
        }
      } catch {
        // Keep polling until execd starts listening.
      }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  }
  startFailure = "execd did not answer on the published port within 30s";
});

after(async () => {
  await docker(["rm", "-f", container], 30_000).catch(() => undefined);
});

function requireClient(t: { skip: (reason: string) => void }): ExecdClient {
  if (!client) {
    t.skip(startFailure || "execd not available");
    throw new Error("unreachable");
  }
  return client;
}

test("execd rejects requests without the access token", async (t) => {
  const execd = requireClient(t);
  const unauthorized = await fetch(`${execd.url}/ping`);
  assert.equal(unauthorized.status, 401);
  const wrong = await fetch(`${execd.url}/ping`, { headers: { "X-EXECD-ACCESS-TOKEN": "wrong" } });
  assert.equal(wrong.status, 401);
  assert.equal((await execd.ping()).ok, true);
});

test("POST /command streams stdout and reports the exit code", async (t) => {
  const execd = requireClient(t);
  const result = await execd.run("echo hello");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "hello");
});

test("POST /command reports non-zero exit codes", async (t) => {
  const execd = requireClient(t);
  assert.equal((await execd.run("exit 3")).exitCode, 3);
});

test("POST /command kills the process when it times out", async (t) => {
  const execd = requireClient(t);
  const started = Date.now();
  const result = await execd.run("sleep 3", { timeoutMs: 300 });
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 5_000, "the command should be killed, not waited out");
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

test("files: non-UTF-8 content needs base64", async (t) => {
  const execd = requireClient(t);
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64");
  await execd.writeFile("blob.bin", binary, "base64");
  await assert.rejects(() => execd.readFile("blob.bin"), /not valid UTF-8/);
  const decoded = await execd.readFile("blob.bin", "base64");
  assert.equal(decoded.content, binary);
});
