import type {
  Message,
  Model,
  ModelRequestOptions,
  ModelStreamEvent,
  ToolCall,
  ToolDefinition,
} from "./types.js";

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const list = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

/**
 * Normalise history before sending it: providers reject some shapes that are
 * harmless internally (an assistant turn with an empty tool_calls array, a tool
 * message with null content, tool call arguments that are not valid JSON).
 */
function sanitizeMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", content: message.content ?? "", tool_call_id: message.tool_call_id };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content ?? "",
        ...(message.tool_calls && message.tool_calls.length > 0
          ? {
              tool_calls: message.tool_calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.function.name, arguments: call.function.arguments || "{}" },
              })),
            }
          : {}),
        // Reasoning models need their own thinking fed back, or the template re-thinks it.
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      };
    }
    return { role: message.role, content: message.content ?? null };
  });
}

/** 429 and 5xx mean "try again in a moment"; connection and auth errors do not. */
function isRetryable(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /^Model API (429|5\d\d):/.test(message);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Small adapter for OpenAI Chat Completions and compatible endpoints. */
export class OpenAICompatibleModel implements Model {
  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    /** Provider-specific fields, e.g. llama.cpp's chat_template_kwargs. */
    private readonly extraBody: Record<string, unknown> = {},
  ) {}

  private body(messages: Message[], tools: ToolDefinition[] = [], stream: boolean): string {
    return JSON.stringify({
      ...this.extraBody,
      model: this.modelName,
      messages: sanitizeMessages(messages),
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({ type: "function", function: tool })),
            tool_choice: "auto",
          }
        : {}),
      ...(stream ? { stream: true } : {}),
    });
  }

  private endpoint(): string {
    return `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[] = [],
    options: ModelRequestOptions = {},
  ): Promise<Message> {
    return this.retrying(options, async () => {
      const response = await this.post(this.body(messages, tools, false), options, false);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: Message; finish_reason?: string }>;
        error?: { message?: string };
      };
      const choice = payload.choices?.[0];
      if (!choice?.message) throw new Error(payload.error?.message ?? "Model returned no message");
      return {
        ...choice.message,
        ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
      };
    });
  }

  /** POST one chat-completions body; connection failures become an actionable error. */
  private async post(body: string, options: ModelRequestOptions, stream: boolean): Promise<Response> {
    const timeout = !stream && options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = combineSignals(options.signal, timeout);
    let response: Response;
    try {
      response = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body,
        signal,
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Cannot reach the model API at ${this.endpoint()}: ${detail}. Is the model server running?`);
    }
    if (!response.ok) throw new Error(`Model API ${response.status}: ${await response.text()}`);
    return response;
  }

  /**
   * Retry only errors that a short wait can fix (rate limits, 5xx). Auth errors,
   * cancellations and unreachable-server errors fail fast.
   */
  private async retrying<T>(options: ModelRequestOptions, run: () => Promise<T>): Promise<T> {
    const attempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (cause) {
        if (attempt >= attempts || options.signal?.aborted || !isRetryable(cause)) throw cause;
        await abortableSleep(400 * attempt, options.signal);
      }
    }
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[] = [],
    options: ModelRequestOptions = {},
  ): AsyncGenerator<ModelStreamEvent> {
    const controller = new AbortController();
    const signal = combineSignals(controller.signal, options.signal);
    const timeoutMs = options.idleTimeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (!timeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(new Error(`Model stream stalled for ${timeoutMs}ms`));
      }, timeoutMs);
    };
    const clearIdle = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    try {
      const response = await this.retrying({ ...options, signal }, () =>
        this.post(this.body(messages, tools, true), { ...options, signal }, true),
      );
      if (!response.body) throw new Error("Model API returned no streaming body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let finishReason: string | undefined;
      const calls = new Map<number, ToolCall>();
      let done = false;

      const consume = (line: string): ModelStreamEvent | undefined => {
        if (!line.startsWith("data:")) return undefined;
        const data = line.slice(5).trim();
        if (!data) return undefined;
        if (data === "[DONE]") {
          done = true;
          return undefined;
        }
        let payload: {
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
        };
        try {
          payload = JSON.parse(data);
        } catch {
          // A provider that degenerates to full JSON bodies instead of SSE deltas
          // ends up here; skip the malformed line rather than killing the run.
          return undefined;
        }
        const choice = payload.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) return undefined;
        // Thinking stays out of the answer, but is kept so history can round-trip.
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        const text = delta.content ?? undefined;
        if (text) content += text;
        for (const part of delta.tool_calls ?? []) {
          const index = part.index ?? 0;
          const current = calls.get(index) ?? {
            id: part.id ?? `call_${index}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.function.name += part.function.name;
          if (part.function?.arguments) current.function.arguments += part.function.arguments;
          calls.set(index, current);
        }
        return text ? { type: "text_delta", text } : undefined;
      };

      try {
        while (!done) {
          armIdle();
          const chunk = await reader.read();
          clearIdle();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = consume(line);
            if (event) yield event;
          }
        }
        if (buffer) {
          const event = consume(buffer);
          if (event) yield event;
        }
      } finally {
        clearIdle();
        await reader.cancel().catch(() => undefined);
      }

      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call)
        .filter((call) => call.function.name);
      yield {
        type: "message",
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(finishReason ? { finishReason } : {}),
        },
      };
    } finally {
      clearIdle();
    }
  }
}
