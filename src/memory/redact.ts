/**
 * Secrets must never reach the vector store: a memory is replayed into future
 * prompts and, unlike a tool result, is never truncated away. Redaction runs on
 * the agent side (before the write leaves the process) and again in the service
 * (defence in depth, so a different client cannot poison the store).
 *
 * The same rule set exists in memory-sidecar.py; keep them in sync.
 */

export interface RedactionResult {
  text: string;
  count: number;
}

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: RedactionRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  {
    // sk-…, pk-…, rk-… (OpenAI, DashScope, provider workspace keys).
    name: "prefixed-key",
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9._-]{12,}\b/g,
    replacement: "[redacted key]",
  },
  {
    name: "aws-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[redacted aws key]",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[redacted token]",
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[redacted token]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[redacted jwt]",
  },
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    replacement: "Bearer [redacted]",
  },
  {
    // KEY=value / api_key: value / password: "…" — keeps the key name for context.
    name: "assignment",
    pattern:
      /(?<![A-Za-z0-9])(api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key)(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;]{6,})/gi,
    replacement: "$1$2[redacted]",
  },
];

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    const matches = text.match(rule.pattern);
    if (!matches || matches.length === 0) continue;
    count += matches.length;
    text = text.replace(rule.pattern, rule.replacement);
  }
  return { text, count };
}

/** Collapse the whitespace that would otherwise waste prompt budget. */
export function normalizeMemoryText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cap a text without splitting a surrogate pair. */
export function capText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const slice = input.slice(0, Math.max(0, maxChars - 1));
  return `${slice.replace(/[\uD800-\uDBFF]$/, "")}…`;
}
