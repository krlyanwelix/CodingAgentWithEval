import type { Message, Model, ToolDefinition } from "./types.js";

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
}
