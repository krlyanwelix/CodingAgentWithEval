import { OpenAICompatibleModel } from "./model.js";
import type { Model, SamplingOptions } from "./types.js";

export interface ModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Hard limit for one non-streaming call. */
  timeoutMs: number;
  /** Abort a stream that stops producing bytes for this long. */
  streamIdleTimeoutMs: number;
  /** Sent with every request so the model cannot ramble or run on. */
  sampling: SamplingOptions;
}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  timeoutMs: 180_000,
  streamIdleTimeoutMs: 120_000,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read the model API settings. Any OpenAI-compatible endpoint works; the
 * defaults target DeepSeek because that is what this agent ships with.
 */
export function readModelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const apiKey = (env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY: set it in .env to call the model API.");
  }
  return {
    baseUrl: (env.OPENAI_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    apiKey,
    model: env.MODEL ?? DEFAULTS.model,
    timeoutMs: positiveInt(env.MODEL_TIMEOUT_MS, DEFAULTS.timeoutMs),
    streamIdleTimeoutMs: positiveInt(env.STREAM_IDLE_TIMEOUT_MS, DEFAULTS.streamIdleTimeoutMs),
    sampling: {
      maxTokens: positiveInt(env.MODEL_MAX_TOKENS, 2048),
      temperature: positiveFloat(env.MODEL_TEMPERATURE, 0.3),
      topP: positiveFloat(env.MODEL_TOP_P, 0.9),
    },
  };
}

export function describeModel(settings: ModelSettings): string {
  return `model "${settings.model}" at ${settings.baseUrl}`;
}

export function createModel(env: NodeJS.ProcessEnv = process.env): { model: Model; settings: ModelSettings } {
  const settings = readModelSettings(env);
  return {
    model: new OpenAICompatibleModel(settings.apiKey, settings.model, settings.baseUrl, settings.sampling),
    settings,
  };
}
