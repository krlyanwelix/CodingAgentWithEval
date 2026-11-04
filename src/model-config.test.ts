import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createModel, describeModel, getServerEndpoint, readModelSettings, readServerInfo } from "./model-config.js";

test("defaults to the local llama.cpp provider", () => {
  const settings = readModelSettings({});
  assert.equal(settings.provider, "local");
  assert.equal(settings.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(settings.model, "qwen3.5-9b");
  assert.equal(settings.apiKey, "local");
  assert.equal(settings.timeoutMs, 900_000);
  assert.equal(settings.streamIdleTimeoutMs, 300_000);
});

test("local provider reads LOCAL_* overrides and strips a trailing slash", () => {
  const settings = readModelSettings({
    LOCAL_MODEL_BASE_URL: "http://192.168.1.20:8081/v1/",
    LOCAL_MODEL: "qwen-local",
    LOCAL_MODEL_API_KEY: "x",
    MODEL_TIMEOUT_MS: "5000",
    STREAM_IDLE_TIMEOUT_MS: "1000",
  });
  assert.equal(settings.baseUrl, "http://192.168.1.20:8081/v1");
  assert.equal(settings.model, "qwen-local");
  assert.equal(settings.apiKey, "x");
  assert.equal(settings.timeoutMs, 5000);
  assert.equal(settings.streamIdleTimeoutMs, 1000);
});

test("remote provider keeps the legacy OPENAI_* settings working", () => {
  const settings = readModelSettings({
    MODEL_PROVIDER: "remote",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://api.deepseek.com/v1",
    MODEL: "deepseek-chat",
  });
  assert.equal(settings.provider, "remote");
  assert.equal(settings.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(settings.model, "deepseek-chat");
  assert.equal(settings.apiKey, "sk-test");
  assert.equal(settings.timeoutMs, 180_000);
});

test("remote provider without a key fails with a helpful message", () => {
  assert.throws(
    () => readModelSettings({ MODEL_PROVIDER: "remote" }),
    /Missing OPENAI_API_KEY/,
  );
});

test("an unknown provider is rejected instead of silently falling back", () => {
  assert.throws(() => readModelSettings({ MODEL_PROVIDER: "ollama" }), /Unsupported MODEL_PROVIDER/);
});

test("local thinking is off by default and can be enabled", () => {
  const off = readModelSettings({});
  assert.equal(off.enableThinking, false);
  assert.deepEqual(off.extraBody, { chat_template_kwargs: { enable_thinking: false } });
  const on = readModelSettings({ LOCAL_MODEL_ENABLE_THINKING: "true" });
  assert.equal(on.enableThinking, true);
  assert.deepEqual(on.extraBody, { chat_template_kwargs: { enable_thinking: true } });
});

test("remote provider sends no chat-template extras", () => {
  const settings = readModelSettings({ MODEL_PROVIDER: "remote", OPENAI_API_KEY: "sk-test" });
  assert.deepEqual(settings.extraBody, {});
  assert.equal(settings.enableThinking, false);
});

test("createModel builds a model without touching the network", () => {
  const { model, settings } = createModel({});
  assert.equal(typeof model.complete, "function");
  assert.equal(
    describeModel(settings),
    'local llama.cpp model "qwen3.5-9b" at http://127.0.0.1:8080/v1 (thinking off)',
  );
});

test("sampling defaults keep a small model short and predictable", () => {
  const settings = readModelSettings({});
  assert.deepEqual(settings.sampling, { maxTokens: 1024, temperature: 0.3, topP: 0.9, repeatPenalty: 1.05 });
});

test("sampling can be tuned from the environment", () => {
  const settings = readModelSettings({
    MODEL_MAX_TOKENS: "256",
    MODEL_TEMPERATURE: "0.7",
    MODEL_TOP_P: "0.5",
    MODEL_REPEAT_PENALTY: "1.2",
  });
  assert.deepEqual(settings.sampling, { maxTokens: 256, temperature: 0.7, topP: 0.5, repeatPenalty: 1.2 });

  const broken = readModelSettings({ MODEL_MAX_TOKENS: "zero", MODEL_TEMPERATURE: "-1" });
  assert.equal(broken.sampling.maxTokens, 1024);
  assert.equal(broken.sampling.temperature, 0.3);
});

test("the hosted API gets no llama.cpp-only sampling field", () => {
  const settings = readModelSettings({ MODEL_PROVIDER: "remote", OPENAI_API_KEY: "sk-test" });
  assert.equal(settings.sampling.repeatPenalty, undefined);
  assert.equal(settings.sampling.maxTokens, 1024);
});

test("the server endpoint drops the /v1 suffix", () => {
  assert.equal(getServerEndpoint("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080");
  assert.equal(getServerEndpoint("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080");
  assert.equal(getServerEndpoint("https://api.deepseek.com"), "https://api.deepseek.com");
});

test("readServerInfo reports the context window llama-server was loaded with", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model_path: "D:\\\\models\\\\qwen3.5-9b-Q4_K_M.gguf",
          default_generation_settings: { n_ctx: 16384 },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const info = await readServerInfo(`http://127.0.0.1:${port}/v1`);
    assert.equal(info.contextLimit, 16384);
    assert.equal(info.modelName, "qwen3.5-9b-Q4_K_M");
  } finally {
    server.close();
  }
});

test("readServerInfo tolerates a server that does not answer", async () => {
  const info = await readServerInfo("http://127.0.0.1:9/v1", 300);
  assert.deepEqual(info, {});
});