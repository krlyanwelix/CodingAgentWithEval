import {
  DEFAULT_CONTEXT_OPTIONS,
  capDigest,
  compactHistory,
  elideLongToolResults,
  estimateMessagesTokens,
  truncateToolOutput,
  type ContextOptions,
} from "./context.js";
import { estimateTokens } from "./tokens.js";
import { classifyToolError } from "./harness/errors.js";
import { describeDecision, evaluateToolCall, type PolicyOptions } from "./harness/policy.js";
import { appendStatus, buildStatusLine } from "./harness/status.js";
import { TraceRecorder } from "./harness/trace.js";
import { formatVerificationFailure, runVerification, type VerifyCheck } from "./harness/verify.js";
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
  /** Capability and risk policy checked before every tool call. */
  policy?: PolicyOptions;
  /** Append a compact state line to the last tool result of each batch. Default true. */
  statusBar?: boolean;
  /** Structured JSONL trace; omitted means no tracing. */
  trace?: TraceRecorder;
  /** Completion gate: these checks must pass before the run may end. */
  verification?: {
    checks: VerifyCheck[];
    /** Repair rounds allowed after a failed answer. Default 1. */
    maxAttempts?: number;
    /** Directory the checks run in. Default process.cwd(). */
    dir?: string;
  };
}

export interface RunOptions {
  /** Same as the second positional argument of run(). */
  context?: string;
  /** Cancels the run; the in-flight model call and tool executions receive it. */
  signal?: AbortSignal;
}

/** One tool call after the cheap checks, waiting to be confirmed and executed. */
interface PreparedCall {
  call: ToolCall;
  kind: "run" | "result";
  value?: string;
  tool?: Tool;
  args?: unknown;
  /** Policy said "ask" even though the tool itself does not require confirmation. */
  needsApproval?: boolean;
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
  /** Consecutive failed tool calls; three in a row stop the run instead of looping. */
  private toolFailureStreak = 0;
  /** Consecutive calls skipped as duplicates; three in a row stop the run. */
  private skippedCallStreak = 0;
  /** Everything below feeds the status line and the trace. */
  private readonly trace: TraceRecorder;
  private readonly statusBar: boolean;
  private toolCallCount = 0;
  private touchedFiles: string[] = [];
  private verificationAttempts = 0;
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(private readonly options: AgentOptions) {
    this.toolByName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
    this.toolDefinitions = options.tools.map((tool) => tool.definition);
    // Enough turns for real exploration; the repeat and failure guards below
    // stop runaway loops instead of a low turn cap.
    this.maxTurns = options.maxTurns ?? 20;
    this.messages = [{ role: "system", content: options.systemPrompt }, ...(options.history ?? [])];
    this.contextOptions = { ...DEFAULT_CONTEXT_OPTIONS, ...(options.context ?? {}) };
    this.trace = options.trace ?? new TraceRecorder();
    this.statusBar = options.statusBar ?? true;
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
    this.toolFailureStreak = 0;
    this.skippedCallStreak = 0;
    this.toolCallCount = 0;
    this.touchedFiles = [];
    this.verificationAttempts = 0;
    this.trace.record("run_start", { input: input.slice(0, 500), maxTurns: this.maxTurns });

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
        if (assistantMessage.usage) {
          this.promptTokens += assistantMessage.usage.promptTokens;
          this.completionTokens += assistantMessage.usage.completionTokens;
        }
        this.messages.push(assistantMessage);
        this.trace.record("model_end", {
          turn,
          finishReason: assistantMessage.finishReason,
          contentChars: (assistantMessage.content ?? "").length,
          toolCalls: assistantMessage.tool_calls?.length ?? 0,
          usage: assistantMessage.usage,
        });
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
          // "Done" is a claim. When a gate is configured, the harness checks the
          // workspace itself and sends the failures back instead of trusting it.
          const verification = this.options.verification;
          if (verification && verification.checks.length > 0 && this.verificationAttempts < (verification.maxAttempts ?? 1)) {
            const results = await runVerification(verification.dir ?? process.cwd(), verification.checks, signal);
            const failed = results.filter((result) => !result.pass);
            this.trace.record("verification", {
              turn,
              passed: results.length - failed.length,
              failed: failed.map((result) => result.name),
            });
            if (failed.length > 0) {
              this.verificationAttempts += 1;
              this.messages.push({ role: "user", content: formatVerificationFailure(results) });
              yield {
                type: "warning",
                message: `Verification failed (${failed.map((result) => result.name).join(", ")}); sending the failures back for repair.`,
              };
              continue;
            }
          }
          this.trace.record("run_end", {
            turn,
            reason: "completed",
            toolCalls: this.toolCallCount,
            promptTokens: this.promptTokens,
            completionTokens: this.completionTokens,
          });
          yield { type: "agent_end", message: assistantMessage };
          return;
        }

        // Announce every call first, run the approved ones at the same time, then
        // report results in call order so the history stays deterministic.
        for (const toolCall of calls) {
          signal?.throwIfAborted();
          yield { type: "tool_start", toolCall };
        }
        this.toolCallCount += calls.length;
        for (const toolCall of calls) this.noteTouched(toolCall);
        this.trace.record("tool_batch", { turn, tools: calls.map((call) => call.function.name) });
        const results = await this.runToolCalls(calls, signal);
        signal?.throwIfAborted();
        const statusLine = this.statusBar
          ? buildStatusLine({
              turn,
              maxTurns: this.maxTurns,
              toolCalls: this.toolCallCount,
              continuousFailures: this.toolFailureStreak,
              contextTokens: this.estimatePayload(),
              contextLimit: Math.max(1, this.contextOptions.maxInputTokens - this.contextOptions.reserveTokens),
              touchedFiles: this.touchedFiles,
            })
          : "";
        for (let index = 0; index < calls.length; index += 1) {
          const toolCall = calls[index]!;
          const result = results[index]!;
          // The status line rides on the last result of the batch: a separate
          // message would break the assistant-tool-call pairing providers expect.
          const content = index === calls.length - 1 ? appendStatus(result, statusLine) : result;
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, content });
          this.trace.record("tool_end", {
            turn,
            tool: toolCall.function.name,
            failed: result.startsWith("Tool error") || /^exit_code: (?!0)\d+/m.test(result),
            resultChars: result.length,
          });
          yield { type: "tool_end", toolCall, result: content };
        }

        const stopReason = this.stopReason();
        if (stopReason) {
          // Stop the loop honestly instead of burning turns on a model that is stuck.
          yield { type: "warning", message: stopReason };
          const stopped: Message = { role: "assistant", content: `[harness] ${stopReason}` };
          this.messages.push(stopped);
          yield { type: "message_end", message: stopped };
          yield { type: "agent_end", message: stopped };
          return;
        }
      }
      const stopped: Message = {
        role: "assistant",
        content: `[harness] Reached the ${this.maxTurns}-turn limit before finishing. The work above may be incomplete.`,
      };
      this.messages.push(stopped);
      yield {
        type: "warning",
        message: `Reached the ${this.maxTurns}-turn limit; stopping instead of failing the whole run.`,
      };
      yield { type: "message_end", message: stopped };
      yield { type: "agent_end", message: stopped };
      return;
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
    const limit = Math.max(1, options.maxInputTokens - options.reserveTokens);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (this.estimatePayload() <= limit) break;

      // Each retry shows the model a cheaper view of the same history: smaller
      // tool results and fewer protected turns. One oversized recent turn must
      // not turn into a hard error in the middle of a session.
      const rest = this.messages.slice(1);
      const working =
        attempt === 0
          ? rest
          : elideLongToolResults(rest, Math.max(200, Math.round(options.toolResultMaxChars / (attempt + 1))));
      const available = Math.max(128, limit - systemTokens - estimateTokens(this.digest));
      const compacted = compactHistory(
        working,
        { ...options, keepRecentTurns: Math.max(1, options.keepRecentTurns - Math.floor(attempt / 2)) },
        available,
      );
      if (compacted.droppedTurns > 0) {
        this.digest = capDigest(`${this.digest}\n${compacted.digest}`.trim(), options.summaryMaxTokens);
      }
      this.messages = [system, ...compacted.messages];
    }

    // Last resort: halve the largest messages until the payload fits. Better to
    // send a shortened history than to fail the run at the door.
    for (let guard = 0; guard < 16 && this.estimatePayload() > limit; guard += 1) {
      const body = this.messages.slice(1);
      let biggest = -1;
      let biggestSize = 0;
      for (let index = 0; index < body.length; index += 1) {
        const size = typeof body[index]!.content === "string" ? (body[index]!.content as string).length : 0;
        if (size > biggestSize) {
          biggest = index;
          biggestSize = size;
        }
      }
      if (biggest < 0 || biggestSize < 240) break;
      const content = body[biggest]!.content as string;
      body[biggest] = {
        ...body[biggest]!,
        content: `${content.slice(0, Math.floor(content.length / 2))}\n\n... [已截断以适配上下文] ...`,
      };
      this.messages = [system, ...body];
    }

    const used = this.estimatePayload();
    if (used > limit) {
      throw new Error(
        `Context budget exceeded: ~${used} tokens > ${limit} allowed. ` +
          `Raise CONTEXT_MAX_INPUT_TOKENS, shorten the prompt, or start a new session.`,
      );
    }
    return this.buildPayload();
  }

  private estimatePayload(): number {
    return estimateMessagesTokens(this.messages) + estimateTokens(this.digest);
  }

  private buildPayload(): Message[] {
    const [system, ...rest] = this.messages;
    const base = system?.content ?? "";
    const content = this.digest ? `${base}\n\n${DIGEST_HEADER}\n${this.digest}` : base;
    return [{ role: "system", content }, ...rest];
  }

  private async runToolCalls(calls: ToolCall[], signal?: AbortSignal): Promise<string[]> {
    const prepared = calls.map((call) => this.prepareCall(call));

    // Policy first: a denied call never reaches the user or the filesystem.
    for (const item of prepared) {
      if (item.kind !== "run" || !item.tool) continue;
      const decision = evaluateToolCall(item.call.function.name, item.args, this.options.policy);
      this.trace.record("policy", {
        tool: item.call.function.name,
        decision: decision.decision,
        risk: decision.risk,
        reason: decision.reason,
      });
      if (decision.decision === "deny") {
        item.kind = "result";
        item.value =
          `Tool error: policy denied this call (${describeDecision(decision)}). ` +
          "Corrective: choose an action inside the allowed capabilities, or explain why it is needed.";
        continue;
      }
      if (decision.decision === "ask") item.needsApproval = true;
    }

    // Confirmation prompts share one terminal, so ask them one at a time.
    for (const item of prepared) {
      if (item.kind !== "run" || !item.tool) continue;
      if (!item.tool.requiresConfirmation && !item.needsApproval) continue;
      const approved = this.options.confirmToolCall ? await this.options.confirmToolCall(item.call) : false;
      if (!approved) {
        item.kind = "result";
        item.value = item.needsApproval
          ? "Tool execution blocked: this call needs approval and was not approved. Corrective: ask before acting, or choose a safer action."
          : "Tool execution cancelled by the user. Corrective: ask before acting, or choose an action the user approves.";
      }
    }

    const outcomes = await Promise.all(
      prepared.map(async (item) => {
        if (item.kind !== "run" || !item.tool) return item.value ?? "";
        try {
          const output = await item.tool.execute(item.args, { signal });
          return this.truncateToolResult(output, item.call.function.name);
        } catch (cause) {
          if (signal?.aborted) throw cause;
          const detail = cause instanceof Error ? cause.message : String(cause);
          return this.truncateToolResult(`Tool error: ${detail}`, item.call.function.name);
        }
      }),
    );

    // Account in call order so hints and streaks do not depend on completion order.
    return outcomes.map((result) => this.accountToolResult(result));
  }

  /** Remember which files this run wrote, for the status line and the trace. */
  private noteTouched(call: ToolCall): void {
    if (call.function.name !== "write" && call.function.name !== "edit") return;
    try {
      const args = JSON.parse(call.function.arguments || "{}") as { path?: unknown };
      if (typeof args.path === "string" && !this.touchedFiles.includes(args.path)) this.touchedFiles.push(args.path);
    } catch {
      // Invalid JSON is already reported by prepareCall; nothing to track here.
    }
  }

  /** Decide what a tool call does without touching the filesystem. */
  private prepareCall(call: ToolCall): PreparedCall {
    const tool = this.toolByName.get(call.function.name);
    if (!tool) {
      return {
        call,
        kind: "result",
        value: `Tool not found: ${call.function.name}. Corrective: only call tools listed in the system prompt.`,
      };
    }

    // The most common small-model loop is repeating a call that already failed.
    const signature = `${call.function.name}:${call.function.arguments}`;
    if (signature === this.lastToolCall) {
      return {
        call,
        kind: "result",
        value:
          `Skipped: this exact call (${call.function.name} ${call.function.arguments}) ` +
          "already ran in the previous step. Corrective: use its result, change the arguments, or answer the user.",
      };
    }
    this.lastToolCall = signature;

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return {
        call,
        kind: "result",
        value:
          `Tool error: arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}. ` +
          'Corrective: send one JSON object, e.g. {"path":"README.md"}.',
      };
    }
    return { call, kind: "run", tool, args };
  }

  /** Track streaks and add a corrective hint once failures repeat. */
  private accountToolResult(result: string): string {
    if (result.startsWith("Skipped")) {
      this.skippedCallStreak += 1;
      this.toolFailureStreak = 0;
      return result;
    }
    this.skippedCallStreak = 0;

    if (!result.startsWith("Tool error")) {
      this.toolFailureStreak = 0;
      return result;
    }

    this.toolFailureStreak += 1;
    const hints: string[] = [];
    const classified = classifyToolError(result);
    if (classified.hint) hints.push(classified.hint);
    else if (/outside the current working directory|ENOENT|no such file/i.test(result)) {
      hints.push("paths are relative to the workspace root; list the directory before reading a guessed name");
    }
    if (this.toolFailureStreak >= 2) {
      hints.push("two tool calls failed in a row: re-read the error and change approach instead of retrying");
    }
    return hints.length > 0 ? `${result}\n\nCorrective: ${hints.join("; ")}.` : result;
  }

  /** Why the loop is about to give up, or undefined while it is still making progress. */
  private stopReason(): string | undefined {
    if (this.toolFailureStreak >= 3) {
      return "Three tool calls failed in a row, so this run was stopped instead of looping.";
    }
    if (this.skippedCallStreak >= 2) {
      return "The model repeated the same tool call three times, so this run was stopped instead of looping.";
    }
    return undefined;
  }

  /** Keep a tool result within a sane size before it enters the history. */
  private truncateToolResult(output: string, toolName: string): string {
    const spill = this.contextOptions.spillDir
      ? { dir: this.contextOptions.spillDir, label: toolName }
      : undefined;
    return truncateToolOutput(output, this.contextOptions, spill).text;
  }
}
