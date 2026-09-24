import type { Message, Model, ModelStreamEvent, ToolCall, ToolDefinition } from "./types.js";

/** Small adapter for OpenAI Chat Completions and compatible endpoints. */
export class OpenAICompatibleModel implements Model {
  constructor(
    private readonly apiKey: string,
    private readonly modelName: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        tools: tools.map((tool) => ({
          type: "function",
          function: tool,
        })),
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Model API ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: Message }>;
      error?: { message?: string };
    };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error(payload.error?.message ?? "Model returned no message");
    return message;
  }

  async *stream(messages: Message[], tools: ToolDefinition[]): AsyncGenerator<ModelStreamEvent> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        tools: tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: "auto",
        stream: true,
      }),
    });
    if (!response.ok) throw new Error(`Model API ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error("Model API returned no streaming body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const calls = new Map<number, ToolCall>();
    let done = false;

    const consume = async (line: string): Promise<ModelStreamEvent | undefined> => {
      if (!line.startsWith("data:")) return undefined;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") { done = data === "[DONE]"; return undefined; }
      const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
      const delta = payload.choices?.[0]?.delta;
      if (!delta) return undefined;
      const text = delta.content ?? undefined;
      if (text) content += text;
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = calls.get(index) ?? { id: part.id ?? `call_${index}`, type: "function", function: { name: "", arguments: "" } };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.function.name += part.function.name;
        if (part.function?.arguments) current.function.arguments += part.function.arguments;
        calls.set(index, current);
      }
      return text ? { type: "text_delta", text } : undefined;
    };

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = await consume(line);
        if (event) yield event;
      }
    }
    if (buffer) {
      const event = await consume(buffer);
      if (event) yield event;
    }
    yield { type: "message", message: { role: "assistant", content: content || null, ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) } };
  }
}
