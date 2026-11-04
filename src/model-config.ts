import { OpenAICompatibleModel } from "./model.js";
import type { Model, SamplingOptions } from "./types.js";

export type ModelProvider = "local" | "remote";

export interface ModelSettings {
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Hard limit for one non-streaming call. */
  timeoutMs: number;
  /** Abort a stream that stops producing bytes for this long. */
  streamIdleTimeoutMs: number;
  /** Local reasoning models "think" before answering; off by default because it is slow. */
  enableThinking: boolean;
  /** Provider-specific request fields merged into every chat-completions body. */
  extraBody: Record<string, unknown>;
  /** Sent with every request so a small model cannot ramble or run on. */
  sampling: SamplingOptions;
}

interface ProviderDefaults {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** llama.cpp's `llama-server` exposes an OpenAI-compatible API on this port by default. */
const LOCAL_DEFAULTS: ProviderDefaults = {
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "qwen3.5-9b",
  timeoutMs: 900_000,
  streamIdleTimeoutMs: 300_000,
};

const REMOTE_DEFAULTS: ProviderDefaults = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
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
 * Pick the model backend. `local` (the default) talks to a llama.cpp server on
 * this machine; `remote` keeps the original OpenAI-compatible API as a
 * fallback, so the old OPENAI_* settings stay usable.
 */
export function readModelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const provider = (env.MODEL_PROVIDER ?? "local").trim().toLowerCase();
  if (provider !== "local" && provider !== "remote") {
    throw new Error(`Unsupported MODEL_PROVIDER "${provider}": expected "local" or "remote".`);
  }
  const defaults = provider === "local" ? LOCAL_DEFAULTS : REMOTE_DEFAULTS;
  const baseUrl = (provider === "local" ? env.LOCAL_MODEL_BASE_URL : env.OPENAI_BASE_URL) ?? defaults.baseUrl;
  const model = (provider === "local" ? env.LOCAL_MODEL : env.MODEL) ?? defaults.model;
  const apiKey = provider === "local" ? env.LOCAL_MODEL_API_KEY ?? "local" : env.OPENAI_API_KEY ?? "";
  if (provider === "remote" && !apiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY for MODEL_PROVIDER=remote. Set the key, or use the default local llama.cpp provider.",
    );
  }
  const enableThinking =
    provider === "local" ? (env.LOCAL_MODEL_ENABLE_THINKING ?? "false").trim().toLowerCase() === "true" : false;
  // An explicit body field still wins: these are defaults, not policy.
  const sampling: SamplingOptions = {
    maxTokens: positiveInt(env.MODEL_MAX_TOKENS, 1024),
    temperature: positiveFloat(env.MODEL_TEMPERATURE, 0.3),
    topP: positiveFloat(env.MODEL_TOP_P, 0.9),
    // `repeat_penalty` is a llama.cpp extension; the hosted API would reject it.
    ...(provider === "local" ? { repeatPenalty: positiveFloat(env.MODEL_REPEAT_PENALTY, 1.05) } : {}),
  };
  return {
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    timeoutMs: positiveInt(env.MODEL_TIMEOUT_MS, defaults.timeoutMs),
    streamIdleTimeoutMs: positiveInt(env.STREAM_IDLE_TIMEOUT_MS, defaults.streamIdleTimeoutMs),
    enableThinking,
    extraBody:
      provider === "local"
        ? { chat_template_kwargs: { enable_thinking: enableThinking } }
        : {},
    sampling,
  };
}

export function describeModel(settings: ModelSettings): string {
  if (settings.provider !== "local") {
    return `remote model "${settings.model}" at ${settings.baseUrl}`;
  }
  const thinking = settings.enableThinking ? "thinking on" : "thinking off";
  return `local llama.cpp model "${settings.model}" at ${settings.baseUrl} (${thinking})`;
}

export function createModel(env: NodeJS.ProcessEnv = process.env): { model: Model; settings: ModelSettings } {
  const settings = readModelSettings(env);
  return {
    model: new OpenAICompatibleModel(
      settings.apiKey,
      settings.model,
      settings.baseUrl,
      settings.extraBody,
      settings.sampling,
    ),
    settings,
  };
}
