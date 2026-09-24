import type { AgentEvent, Message, Model, Tool, ToolCall } from "./types.js";

export interface AgentOptions {
  model: Model;
  tools: Tool[];
  systemPrompt: string;
  maxTurns?: number;
  history?: Message[];
}

/**
 * The agent loop: ask the model, append its response, execute requested tools,
 * append tool results, and repeat until the model responds without tool calls.
 */
export class Agent {
  private readonly toolByName: Map<string, Tool>;
  private readonly maxTurns: number;
  private readonly messages: Message[];

  constructor(private readonly options: AgentOptions) {
    this.toolByName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
    this.maxTurns = options.maxTurns ?? 12;
    this.messages = [{ role: "system", content: options.systemPrompt }, ...(options.history ?? [])];
  }

  async *run(input: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: input });

    try {
      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        yield { type: "message_start", turn };
        const assistantMessage = await this.options.model.complete(
          this.messages,
          this.options.tools.map((tool) => tool.definition),
        );
        this.messages.push(assistantMessage);
        yield { type: "message_end", message: assistantMessage };

        const calls = assistantMessage.tool_calls ?? [];
        if (calls.length === 0) {
          yield { type: "agent_end", message: assistantMessage };
          return;
        }

        for (const toolCall of calls) {
          yield { type: "tool_start", toolCall };
          const result = await this.executeTool(toolCall);
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
          yield { type: "tool_end", toolCall, result };
        }
      }
      throw new Error(`Agent reached the ${this.maxTurns}-turn limit`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      yield { type: "error", error };
      throw error;
    }
  }

  private async executeTool(call: ToolCall): Promise<string> {
    const tool = this.toolByName.get(call.function.name);
    if (!tool) return `Tool not found: ${call.function.name}`;
    try {
      const args: unknown = JSON.parse(call.function.arguments || "{}");
      return await tool.execute(args);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `Tool error: ${detail}`;
    }
  }
}
