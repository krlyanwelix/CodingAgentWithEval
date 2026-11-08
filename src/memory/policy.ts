import { capText, normalizeMemoryText } from "./redact.js";

/**
 * Write-side policy. Extraction costs one model call plus embeddings, and a
 * memory store polluted with "ok" / "thanks" makes recall worse, so the agent
 * decides *whether* a turn is worth remembering before calling the service.
 * What exactly to keep inside an accepted turn stays the extractor's job.
 */

/** Turns that carry no durable information no matter the session. */
const TRIVIAL_TURN =
  /^(?:ok(?:ay)?|k|thanks?|thank you|thx|ty|yes|no|yep|nope|sure|got it|hi|hello|hey|你好|谢谢|好的|收到|嗯+|在吗)[\s.!?。！？~]*$/iu;

export const MEMORY_MIN_CHARS = 40;
export const MEMORY_MAX_CHARS = 1600;

export function isTrivialTurn(text: string): boolean {
  return TRIVIAL_TURN.test(text.trim());
}

export function shouldRemember(text: string, minChars = MEMORY_MIN_CHARS): boolean {
  const trimmed = text.trim();
  if (trimmed.length < minChars) return false;
  if (isTrivialTurn(trimmed)) return false;
  // A single repeated character ("aaaa…") or pure punctuation is noise.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;
  return true;
}

/**
 * Collapse the turn into the excerpt the extractor sees: user and assistant
 * prose only. Tool traffic is dropped — it is huge, transient, and already
 * summarised into the assistant's answer.
 */
export function summarizeTurn(
  messages: readonly { role: string; content: string | null }[],
  maxChars = MEMORY_MAX_CHARS,
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) continue;
    if (content.startsWith("[harness]")) continue;
    parts.push(`${message.role === "user" ? "User" : "Assistant"}: ${content}`);
  }
  return capText(normalizeMemoryText(parts.join("\n")), maxChars);
}

/** Explicit `/remember` bypasses the length heuristic but not redaction. */
export function explicitMemoryText(raw: string, maxChars = MEMORY_MAX_CHARS): string | undefined {
  const text = capText(normalizeMemoryText(raw), maxChars);
  return text.length === 0 ? undefined : text;
}
