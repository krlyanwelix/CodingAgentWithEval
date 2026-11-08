import assert from "node:assert/strict";
import test from "node:test";
import { formatMemoryBlock, MEMORY_BLOCK_HEADER } from "./format.js";
import { projectIdFor } from "./index.js";
import { shouldRemember, summarizeTurn } from "./policy.js";
import { capText, normalizeMemoryText, redactSecrets } from "./redact.js";
import { MemoryService } from "./service.js";
import type { MemoryHit } from "./types.js";

const SECRET_KEY =
  "sk-ws-H.YEMLRRI.KH81.MEQCIDCDT9X4jm41BTMPigfyWACCqIbvvhQowKIzWxGHWWvqAiBAeCBbKcrC6vP9J_-MC8wlGT22FoCmyerhThemqgQ-Rg";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<{ status?: number; body?: unknown }>,
) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const result = await handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), { status: result.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function newService(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}): MemoryService {
  return new MemoryService({
    baseUrl: "http://memory.test",
    userId: "user-1",
    projectId: "proj-1",
    autoStart: false,
    fetchImpl,
    warn: () => {},
    ...overrides,
  });
}

test("redactSecrets removes provider keys, private keys and env assignments", () => {
  const sample = `key ${SECRET_KEY} and OPENAI_API_KEY=abcdef123456 and password: "hunter2hunter2"`;
  const result = redactSecrets(sample);
  assert.equal(result.text.includes(SECRET_KEY), false);
  assert.equal(result.text.includes("abcdef123456"), false);
  assert.equal(result.text.includes("hunter2hunter2"), false);
  assert.ok(result.count >= 3, `expected at least 3 redactions, got ${result.count}`);

  const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactSecrets(privateKey).text.includes("MIIEow"), false);

  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redactSecrets(jwt).text, "[redacted jwt]");

  const bearer = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345";
  assert.equal(redactSecrets(bearer).text.includes("abcdefghijklmnop"), false);
});

test("redactSecrets leaves ordinary prose alone", () => {
  const prose = "The retry policy uses 3 attempts and a 2s backoff between them.";
  const result = redactSecrets(prose);
  assert.equal(result.text, prose);
  assert.equal(result.count, 0);
});

test("normalizeMemoryText and capText bound what we store", () => {
  assert.equal(normalizeMemoryText("a  b\r\n\r\n\r\nc "), "a b\n\nc");
  assert.equal(capText("abcdef", 4).length, 4);
  assert.ok(capText("abcdef", 4).endsWith("…"));
});

test("shouldRemember rejects small talk but keeps decisions", () => {
  assert.equal(shouldRemember("ok"), false);
  assert.equal(shouldRemember("thanks!"), false);
  assert.equal(shouldRemember("short"), false);
  assert.equal(
    shouldRemember("We decided to keep better-sqlite3 instead of adding a new database driver."),
    true,
  );
});

test("summarizeTurn keeps user and assistant prose and drops harness noise", () => {
  const text = summarizeTurn([
    { role: "system", content: "system prompt" },
    { role: "user", content: "why is the build slow?" },
    { role: "tool", content: "exit_code: 0" },
    { role: "assistant", content: "[harness] 第 1/20 轮 · 工具 0 次" },
    { role: "assistant", content: "Because tsc rechecks every file on each run." },
  ]);
  assert.ok(text.includes("User: why is the build slow?"));
  assert.ok(text.includes("Assistant: Because tsc rechecks"));
  assert.equal(text.includes("exit_code"), false);
  assert.equal(text.includes("[harness]"), false);
});

test("formatMemoryBlock labels memories untrusted and respects the budget", () => {
  assert.equal(formatMemoryBlock([]), undefined);
  const hits: MemoryHit[] = [
    { id: "1", text: "prefers pnpm over npm", score: 0.82, kind: "preference", createdAt: "2026-11-01T10:00:00Z" },
    { id: "2", text: "x".repeat(200), score: 0.4 },
  ];
  const block = formatMemoryBlock(hits, 160);
  assert.ok(block?.startsWith(MEMORY_BLOCK_HEADER));
  assert.ok(block?.includes("preference"));
  assert.ok(block?.includes("(+1 more memories not shown)"));
});

test("recall maps service hits and sends the scope", async () => {
  const { impl, calls } = fakeFetch(async (url) => {
    if (url.endsWith("/health")) return { body: { status: "ok" } };
    return {
      body: {
        hits: [
          { id: "m1", text: "uses pnpm", score: 0.9, kind: "preference", created_at: "2026-11-01T00:00:00Z" },
          { id: "m2", text: "   ", score: 0.5 },
        ],
      },
    };
  });
  const service = newService(impl);
  assert.equal(await service.start(), true);
  const hits = await service.recall("package manager?");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "uses pnpm");
  assert.equal(hits[0].kind, "preference");

  const search = calls.find((call) => call.url.endsWith("/v1/memories/search"));
  assert.equal(search?.body?.user_id, "user-1");
  assert.equal(search?.body?.project_id, "proj-1");
  assert.equal(search?.body?.budget_chars, 900);
});

test("forget scopes the delete through the query string", async () => {
  const { impl, calls } = fakeFetch(async (url) => {
    if (url.endsWith("/health")) return { body: { status: "ok" } };
    return { body: { deleted: "m1" } };
  });
  const service = newService(impl);
  await service.start();
  await service.forget("m1");
  const del = calls.find((call) => call.url.includes("/v1/memories/m1"));
  assert.ok(del, "expected a delete request");
  assert.match(del.url, /[?&]user_id=user-1/);
  assert.equal(del.body, undefined, "delete must not send a body the server reads as query params");
});

test("recall fails open when the service is down", async () => {
  const { impl } = fakeFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  const service = newService(impl);
  assert.equal(await service.start(), false);
  assert.deepEqual(await service.recall("anything"), []);
  const result = await service.remember({ text: "a durable preference about testing" });
  assert.equal(result.written, 0);
});

test("remember redacts secrets before they leave the process", async () => {
  const { impl, calls } = fakeFetch(async (url) => {
    if (url.endsWith("/health")) return { body: { status: "ok" } };
    return { body: { written: [{ id: "m1", text: "ok" }], skipped: [] } };
  });
  const service = newService(impl);
  await service.start();
  const result = await service.remember({ text: `my token is ${SECRET_KEY}` });
  assert.equal(result.written, 1);
  const write = calls.find((call) => call.url.endsWith("/v1/memories"));
  assert.ok(write);
  assert.equal(String(write?.body?.text).includes(SECRET_KEY), false);
  assert.ok(String(write?.body?.text).includes("[redacted key]"));
  assert.equal(write?.body?.infer, false);
});

test("remember skips trivial turns without calling the service", async () => {
  const { impl, calls } = fakeFetch(async (url) => {
    if (url.endsWith("/health")) return { body: { status: "ok" } };
    return { body: { written: [], skipped: [] } };
  });
  const service = newService(impl);
  await service.start();
  const result = await service.remember({ messages: [{ role: "user", content: "ok" }], infer: true });
  assert.equal(result.written, 0);
  assert.equal(calls.some((call) => call.url.endsWith("/v1/memories")), false);
});

test("projectIdFor is stable per checkout and distinct across checkouts", () => {
  const first = projectIdFor("E:\\dsh_workspace\\pro2\\myAgentProject");
  const second = projectIdFor("E:\\dsh_workspace\\pro2\\myAgentProject");
  assert.equal(first, second);
  assert.notEqual(first, projectIdFor("E:\\dsh_workspace\\pro2\\other"));
  assert.match(first, /^myAgentProject-[0-9a-f]{8}$/);
});
