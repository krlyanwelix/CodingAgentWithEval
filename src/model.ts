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
    const content = message.content ?? (message.role === "assistant" || message.role === "tool" ? "" : null);
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.function.name, arguments: call.function.arguments || "{}" },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", content, tool_call_id: message.tool_call_id };
    }
    return { role: message.role, content };
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
    const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = combineSignals(options.signal, timeout);
    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: this.body(messages, tools, false),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Model API ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: Message; finish_reason?: string }>;
      error?: { message?: string };
    };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error(payload.error?.message ?? "Model returned no message");
    return message;
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
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: this.body(messages, tools, true),
        signal,
      });
      if (!response.ok) throw new Error(`Model API ${response.status}: ${await response.text()}`);
      if (!response.body) throw new Error("Model API returned no streaming body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
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
            delta?: {
              content?: string | null;
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
        const delta = payload.choices?.[0]?.delta;
        if (!delta) return undefined;
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
        },
      };
    } finally {
      clearIdle();
    }
  }
}
