import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Message } from "./types.js";
import { estimateTokens } from "./tokens.js";

/**
 * Token budgeting for the model context.
 *
 * The agent never trusts a real tokenizer (it has none), so everything here is a
 * deliberate over-estimate: CJK characters cost ~1 token each and the rest ~3.6
 * characters per token, rounded up. Models break long before the budget says so,
 * which is the point — a conservative estimate makes compaction happen early
 * rather than after a 400 from the API.
 */
export interface ContextOptions {
  /** Hard ceiling for the estimated prompt size sent to the model. */
  maxInputTokens: number;
  /** Room left for the model's reply and tool-call arguments. */
  reserveTokens: number;
  /** Always keep at least this many of the most recent turns verbatim. */
  keepRecentTurns: number;
  /** Upper bound for the running summary of dropped turns. */
  summaryMaxTokens: number;
  /** A single tool result longer than this is truncated before it enters history. */
  toolResultMaxChars: number;
  toolResultHeadChars: number;
  toolResultTailChars: number;
  /** Directory that receives the full text of oversized tool results; omit to disable. */
  spillDir?: string;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  maxInputTokens: 24000,
  reserveTokens: 2048,
  keepRecentTurns: 3,
  summaryMaxTokens: 800,
  toolResultMaxChars: 4000,
  toolResultHeadChars: 1500,
  toolResultTailChars: 1000,
};

export function estimateMessageTokens(message: Message): number {
  let tokens = 8 + estimateTokens(message.content);
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      tokens += 12 + estimateTokens(call.function.name) + estimateTokens(call.function.arguments);
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** Split a history into turns; a turn starts at a user message. */
export function splitTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * One-line-per-turn digest used to carry dropped history forward. It records who
 * said what and which tools ran, not tool output — details are what the model can
 * re-fetch with a tool call.
 */
export function digestTurns(turns: Message[][]): string {
  const lines: string[] = [];
  turns.forEach((turn, index) => {
    const user = turn.find((message) => message.role === "user");
    if (user) lines.push(`- [第 ${index + 1} 轮] 用户: ${clip(user.content ?? "", 160)}`);
    for (const message of turn) {
      if (message.role === "assistant") {
        const text = clip(message.content ?? "", 160);
        const tools = (message.tool_calls ?? []).map((call) => call.function.name);
        const toolNote = tools.length > 0 ? ` 工具:${tools.join(",")}` : "";
        if (text || toolNote) lines.push(`  助手: ${text}${toolNote}`);
      } else if (message.role === "tool") {
        lines.push(`  工具结果: ${clip(message.content ?? "", 120)}`);
      }
    }
  });
  return lines.join("\n");
}

/** Keep the newest digest lines when the digest outgrows its budget. */
export function capDigest(digest: string, maxTokens: number): string {
  if (!digest || estimateTokens(digest) <= maxTokens) return digest;
  const lines = digest.split("\n");
  const kept: string[] = [];
  let tokens = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens) break;
    kept.unshift(line);
    tokens += cost;
  }
  return kept.length === 0 ? "" : `（较早的对话摘要已省略）\n${kept.join("\n")}`;
}

export interface CompactionResult {
  messages: Message[];
  droppedTurns: number;
  /** Digest of the dropped turns; empty when nothing was dropped. */
  digest: string;
  /** Estimated tokens of the kept messages (the digest is not included). */
  estimatedTokens: number;
}

/**
 * Drop the oldest whole turns until the remaining history fits the budget. The
 * most recent `keepRecentTurns` turns are always kept; if they alone blow the
 * budget the caller still has to elide or truncate content, so `estimatedTokens`
 * is reported honestly rather than promised to fit.
 */
export function compactHistory(messages: Message[], options: ContextOptions, budgetTokens: number): CompactionResult {
  const turns = splitTurns(messages);
  const total = estimateMessagesTokens(messages);
  if (total <= budgetTokens) {
    return { messages, droppedTurns: 0, digest: "", estimatedTokens: total };
  }

  const keepCount = Math.max(1, options.keepRecentTurns);
  const kept: Message[][] = [];
  let keptTokens = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const turnTokens = estimateMessagesTokens(turn);
    const mustKeep = kept.length < keepCount;
    if (!mustKeep && keptTokens + turnTokens > budgetTokens) break;
    kept.unshift(turn);
    keptTokens += turnTokens;
  }

  const dropped = turns.slice(0, turns.length - kept.length);
  const digest = capDigest(digestTurns(dropped), options.summaryMaxTokens);
  return {
    messages: kept.flat(),
    droppedTurns: dropped.length,
    digest,
    estimatedTokens: keptTokens,
  };
}

/** Middle-out elision for tool results that are already in history. */
export function elideLongToolResults(messages: Message[], maxChars: number): Message[] {
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.4);
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;
    const content = message.content;
    if (content.length <= maxChars) return message;
    return {
      ...message,
      content: `${content.slice(0, headChars)}\n\n... [工具结果已省略 ${content.length - headChars - tailChars} 字符] ...\n\n${content.slice(-tailChars)}`,
    };
  });
}

export interface TruncatedText {
  text: string;
  /** Path of the spooled full output, when spilling was enabled. */
  spilledTo?: string;
  fullLength: number;
}

/**
 * Keep the head and tail of an oversized tool result, note how much was dropped
 * and (when configured) spool the full text to disk so the model can re-read it.
 */
export function truncateToolOutput(
  output: string,
  options: Pick<ContextOptions, "toolResultMaxChars" | "toolResultHeadChars" | "toolResultTailChars">,
  spill?: { dir: string; label: string },
): TruncatedText {
  if (output.length <= options.toolResultMaxChars) {
    return { text: output, fullLength: output.length };
  }
  const head = output.slice(0, options.toolResultHeadChars);
  const tail = output.slice(-options.toolResultTailChars);
  const omitted = output.length - head.length - tail.length;

  let spilledTo: string | undefined;
  if (spill) {
    const safeLabel = spill.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "tool";
    const fileName = `${safeLabel}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
    try {
      mkdirSync(spill.dir, { recursive: true });
      spilledTo = join(spill.dir, fileName);
      writeFileSync(spilledTo, output, "utf8");
    } catch {
      spilledTo = undefined;
    }
  }

  const note = spilledTo
    ? `共 ${output.length} 字符，中间 ${omitted} 字符已省略；完整输出已写入 ${spilledTo}，需要时可读取该文件`
    : `共 ${output.length} 字符，中间 ${omitted} 字符已省略；如需原文请分段重试`;

  return {
    text: `${head}\n\n... [输出过长，已截断：${note}] ...\n\n${tail}`,
    spilledTo,
    fullLength: output.length,
  };
}
