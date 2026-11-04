import assert from "node:assert/strict";
import test from "node:test";
import { createModel, describeModel, readModelSettings } from "./model-config.js";
import { OpenAICompatibleModel } from "./model.js";

test("defaults point at DeepSeek and cap the answer length", () => {
  const settings = readModelSettings({ OPENAI_API_KEY: "sk-test" });
  assert.equal(settings.baseUrl, "https://api.deepseek.com");
  assert.equal(settings.model, "deepseek-flash");
  assert.equal(settings.timeoutMs, 180_000);
  assert.equal(settings.streamIdleTimeoutMs, 120_000);
  assert.deepEqual(settings.sampling, { maxTokens: 2048, temperature: 0.3, topP: 0.9 });
});

test("environment overrides win and a trailing slash is stripped", () => {
  const settings = readModelSettings({
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://api.example.com/v1/",
    MODEL: "custom-model",
    MODEL_TIMEOUT_MS: "5000",
    STREAM_IDLE_TIMEOUT_MS: "1000",
  });
  assert.equal(settings.baseUrl, "https://api.example.com/v1");
  assert.equal(settings.model, "custom-model");
  assert.equal(settings.timeoutMs, 5000);
  assert.equal(settings.streamIdleTimeoutMs, 1000);
});

test("a missing API key is reported clearly", () => {
  assert.throws(() => readModelSettings({}), /Missing OPENAI_API_KEY/);
  assert.throws(() => readModelSettings({ OPENAI_API_KEY: "   " }), /Missing OPENAI_API_KEY/);
});

test("sampling can be tuned, invalid values fall back", () => {
  const tuned = readModelSettings({
    OPENAI_API_KEY: "sk-test",
    MODEL_MAX_TOKENS: "256",
    MODEL_TEMPERATURE: "0.7",
    MODEL_TOP_P: "0.5",
  });
  assert.deepEqual(tuned.sampling, { maxTokens: 256, temperature: 0.7, topP: 0.5 });

  const broken = readModelSettings({ OPENAI_API_KEY: "sk-test", MODEL_MAX_TOKENS: "zero", MODEL_TEMPERATURE: "-1" });
  assert.equal(broken.sampling.maxTokens, 2048);
  assert.equal(broken.sampling.temperature, 0.3);
});

test("describeModel names the model and endpoint", () => {
  const settings = readModelSettings({ OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://x.test/v1", MODEL: "m1" });
  assert.equal(describeModel(settings), 'model "m1" at https://x.test/v1');
});

test("createModel builds a configured model without the network", () => {
  const { model, settings } = createModel({ OPENAI_API_KEY: "sk-test" });
  assert.ok(model instanceof OpenAICompatibleModel);
  assert.equal(settings.apiKey, "sk-test");
});
