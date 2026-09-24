export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: unknown): Promise<string>;
}

export interface Model {
  complete(messages: Message[], tools: ToolDefinition[]): Promise<Message>;
}

export type AgentEvent =
  | { type: "message_start"; turn: number }
  | { type: "message_end"; message: Message }
  | { type: "tool_start"; toolCall: ToolCall }
  | { type: "tool_end"; toolCall: ToolCall; result: string }
  | { type: "agent_end"; message: Message }
  | { type: "error"; error: Error };
