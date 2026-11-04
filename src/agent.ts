import {
  DEFAULT_CONTEXT_OPTIONS,
  capDigest,
  compactHistory,
  elideLongToolResults,
  estimateMessagesTokens,
  estimateTokens,
  truncateToolOutput,
  type ContextOptions,
} from "./context.js";
import type { AgentEvent, Message, Model, Tool, ToolCall, ToolDefinition } from "./types.js";

export interface AgentOptions {
  model: Model;
  tools: Tool[];
  systemPrompt: string;
  maxTurns?: number;
  history?: Message[];
  confirmToolCall?: (toolCall: ToolCall) => Promise<boolean>;
  /** Token budgeting overrides; unset fields fall back to DEFAULT_CONTEXT_OPTIONS. */
  context?: Partial<ContextOptions>;
  /** Hard timeout for one non-streaming model call. */
  modelTimeoutMs?: number;
  /** Abort a streaming call when no bytes arrive for this long. */
  streamIdleTimeoutMs?: number;
}

export interface RunOptions {
  /** Same as the second positional argument of run(). */
  context?: string;
  /** Cancels the run; the in-flight model call and tool executions receive it. */
  signal?: AbortSignal;
}

const DIGEST_HEADER = "[已压缩的早期对话摘要]";

/**
 * The agent loop: ask the model, append its response, execute requested tools,
 * append tool results, and repeat until the model responds without tool calls.
 *
 * Before every model call the history is fitted into a token budget: whole old
 * turns are dropped into a running digest, oversized tool results are elided, and
 * the system prompt carries the digest forward so the model keeps the gist.
 */
export class Agent {
  private readonly toolByName: Map<string, Tool>;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly maxTurns: number;
  private readonly contextOptions: ContextOptions;
  private messages: Message[];
  /** Digest of turns dropped by compaction; appended to the system prompt. */
  private digest = "";
  /** Name+args of the previous tool call, used to catch identical retries. */
  private lastToolCall?: string;
  private consecutiveToolFailures = 0;

  constructor(private readonly options: AgentOptions) {
    this.toolByName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
    this.toolDefinitions = options.tools.map((tool) => tool.definition);
    // A local 9B model needs a few extra turns to explore; the repeat guard
    // below stops runaway loops instead of a low turn cap.
    this.maxTurns = options.maxTurns ?? 20;
    this.messages = [{ role: "system", content: options.systemPrompt }, ...(options.history ?? [])];
    this.contextOptions = { ...DEFAULT_CONTEXT_OPTIONS, ...(options.context ?? {}) };
  }

  /** The full conversation, including the leading system message. */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  async *run(input: string, options?: string | RunOptions): AsyncGenerator<AgentEvent> {
    const runOptions: RunOptions = typeof options === "string" ? { context: options } : (options ?? {});
    const signal = runOptions.signal;
    this.messages.push({
      role: "user",
      content: runOptions.context ? `${input}\n\n${runOptions.context}` : input,
    });
    this.lastToolCall = undefined;
    this.consecutiveToolFailures = 0;

    let partial = "";
    try {
      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        signal?.throwIfAborted();
        partial = "";
        yield { type: "message_start", turn };

        let assistantMessage: Message;
        const payload = this.preparePayload();
        if (this.options.model.stream) {
          assistantMessage = { role: "assistant", content: null };
          const stream = this.options.model.stream(payload, this.toolDefinitions, {
            signal,
            idleTimeoutMs: this.options.streamIdleTimeoutMs,
          });
          for await (const event of stream) {
            if (event.type === "text_delta") {
              partial += event.text;
              yield { type: "text_delta", text: event.text };
            } else {
              assistantMessage = event.message;
            }
          }
        } else {
          assistantMessage = await this.options.model.complete(payload, this.toolDefinitions, {
            signal,
            timeoutMs: this.options.modelTimeoutMs,
          });
        }

        signal?.throwIfAborted();
        this.messages.push(assistantMessage);
        yield { type: "message_end", message: assistantMessage };

        const calls = assistantMessage.tool_calls ?? [];
        const truncated = assistantMessage.finishReason === "length" || assistantMessage.finishReason === "max_tokens";
        if (truncated) {
          yield {
            type: "warning",
            message:
              "The model stopped at its output limit, so this answer is cut off. " +
              "Ask for a smaller piece, or raise the server's max tokens.",
          };
        }
        if (calls.length === 0) {
          if (!truncated && !(assistantMessage.content ?? "").trim() && !assistantMessage.reasoning_content) {
            yield { type: "warning", message: "The model returned an empty answer." };
          }
          yield { type: "agent_end", message: assistantMessage };
          return;
        }

        for (const toolCall of calls) {
          signal?.throwIfAborted();
          yield { type: "tool_start", toolCall };
          const result = await this.executeTool(toolCall, signal);
          signal?.throwIfAborted();
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
          yield { type: "tool_end", toolCall, result };
        }
      }
      throw new Error(`Agent reached the ${this.maxTurns}-turn limit`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (signal?.aborted) {
        // A cancelled run is not a failure: report what was streamed so the caller
        // can keep it and return normally instead of surfacing an abort error.
        yield { type: "aborted", partial };
        return;
      }
      yield { type: "error", error };
      throw error;
    }
  }

  /**
   * Fit the history into the input budget before a model call:
   * 1. drop the oldest whole turns (keeping `keepRecentTurns`) into the digest,
   * 2. if still too large, elide oversized tool results in place,
   * 3. if still too large after retries, fail loudly instead of sending a doomed request.
   */
  private preparePayload(): Message[] {
    const options = this.contextOptions;
    const system = this.messages[0]!;
    const systemTokens = estimateMessagesTokens([system]);
    const limit = options.maxInputTokens - options.reserveTokens;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rest = this.messages.slice(1);
      const used = estimateMessagesTokens(rest) + estimateTokens(this.digest) + systemTokens;
      if (used <= limit) break;

      const working =
        attempt === 0
          ? rest
          : elideLongToolResults(rest, Math.max(600, Math.round(options.toolResultMaxChars * 0.4)));
      const available = limit - systemTokens - estimateTokens(this.digest);
      const compacted = compactHistory(working, options, Math.max(256, available));
      if (compacted.droppedTurns > 0) {
        this.digest = capDigest(`${this.digest}\n${compacted.digest}`.trim(), options.summaryMaxTokens);
      }
      this.messages = [system, ...compacted.messages];
    }

    const used = estimateMessagesTokens(this.messages) + estimateTokens(this.digest);
    if (used > limit) {
      throw new Error(
        `Context budget exceeded: ~${used} tokens > ${limit} allowed. ` +
          `Raise CONTEXT_MAX_INPUT_TOKENS, shorten the prompt, or start a new session.`,
      );
    }
    return this.buildPayload();
  }

  private buildPayload(): Message[] {
    const [system, ...rest] = this.messages;
    const base = system?.content ?? "";
    const content = this.digest ? `${base}\n\n${DIGEST_HEADER}\n${this.digest}` : base;
    return [{ role: "system", content }, ...rest];
  }

  private async executeTool(call: ToolCall, signal?: AbortSignal): Promise<string> {
    const tool = this.toolByName.get(call.function.name);
    if (!tool) return `Tool not found: ${call.function.name}`;
    if (tool.requiresConfirmation) {
      const approved = this.options.confirmToolCall ? await this.options.confirmToolCall(call) : false;
      if (!approved) return "Tool execution cancelled by the user.";
    }

    // The most common small-model loop is repeating a call that already failed.
    const signature = `${call.function.name}:${call.function.arguments}`;
    if (signature === this.lastToolCall) {
      return (
        `Skipped: this exact call (${call.function.name} ${call.function.arguments}) ` +
        "already ran in the previous step. Use its result, try different arguments, or answer the user."
      );
    }
    this.lastToolCall = signature;

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return `Tool error: arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`;
    }

    let result: string;
    try {
      const output = await tool.execute(args, { signal });
      result = this.truncateToolResult(output, call.function.name);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      result = this.truncateToolResult(`Tool error: ${detail}`, call.function.name);
    }

    if (result.startsWith("Tool error")) {
      this.consecutiveToolFailures += 1;
      if (this.consecutiveToolFailures >= 2) {
        result +=
          "\n\nHint: two tool calls failed in a row. Re-read the error, check the path or content, " +
          "and change approach instead of retrying.";
      }
    } else {
      this.consecutiveToolFailures = 0;
    }
    return result;
  }

  /** Keep a tool result within a sane size before it enters the history. */
  private truncateToolResult(output: string, toolName: string): string {
    const spill = this.contextOptions.spillDir
      ? { dir: this.contextOptions.spillDir, label: toolName }
      : undefined;
    return truncateToolOutput(output, this.contextOptions, spill).text;
  }
}
