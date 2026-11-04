export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Thinking returned by reasoning models; kept so history round-trips unchanged. */
  reasoning_content?: string;
  /** Provider stop reason, e.g. "stop", "length", "tool_calls". */
  finishReason?: string;
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

/** Per-call context handed to a tool so long-running work can be cancelled. */
export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool {
  definition: ToolDefinition;
  requiresConfirmation?: boolean;
  execute(args: unknown, context?: ToolContext): Promise<string>;
}

export interface ModelRequestOptions {
  /** Cancels the in-flight request. */
  signal?: AbortSignal;
  /** Hard timeout for one non-streaming call. */
  timeoutMs?: number;
  /** Abort a stream when no bytes arrive for this long. */
  idleTimeoutMs?: number;
}

/**
 * Sampling parameters sent with every request. Small local models need an
 * explicit cap and a low temperature or they ramble and repeat themselves.
 */
export interface SamplingOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface Model {
  complete(messages: Message[], tools: ToolDefinition[], options?: ModelRequestOptions): Promise<Message>;
  stream?(messages: Message[], tools: ToolDefinition[], options?: ModelRequestOptions): AsyncGenerator<ModelStreamEvent>;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "message"; message: Message };

export type AgentEvent =
  | { type: "message_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_start"; toolCall: ToolCall }
  | { type: "tool_end"; toolCall: ToolCall; result: string }
  | { type: "agent_end"; message: Message }
  /** Non-fatal problem the caller should surface, e.g. a truncated answer. */
  | { type: "warning"; message: string }
  /** The run stopped because the caller aborted; `partial` is the text streamed so far. */
  | { type: "aborted"; partial: string }
  | { type: "error"; error: Error };
