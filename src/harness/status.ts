/**
 * The status bar.
 *
 * Everything that changes during a run (turn number, tool count, failure streak,
 * context usage, touched files) is appended to the *tail* of the trajectory, not
 * to the system prompt. The system prompt therefore stays a byte-stable prefix
 * that providers can cache, and the model still sees fresh state.
 */

export interface StatusState {
  turn: number;
  maxTurns: number;
  toolCalls: number;
  continuousFailures: number;
  /** Estimated prompt tokens of the last request. */
  contextTokens?: number;
  /** Input budget the prompt is fitted into. */
  contextLimit?: number;
  /** Workspace-relative paths written in this run, most recent last. */
  touchedFiles?: string[];
  /** Pending verification attempts, if a verification gate is configured. */
  verification?: { passed: number; failed: number };
}

function thousands(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** One compact line; empty string when there is nothing worth reporting. */
export function buildStatusLine(state: StatusState): string {
  const parts = [`第 ${state.turn}/${state.maxTurns} 轮`, `工具 ${state.toolCalls} 次`];
  if (state.continuousFailures > 0) parts.push(`连续失败 ${state.continuousFailures} 次`);
  if (state.contextTokens !== undefined && state.contextLimit !== undefined) {
    parts.push(`上下文 ~${thousands(state.contextTokens)}/${thousands(state.contextLimit)} tokens`);
  }
  if (state.verification) {
    parts.push(`验证 ${state.verification.passed} 通过 / ${state.verification.failed} 失败`);
  }
  const files = state.touchedFiles ?? [];
  if (files.length > 0) {
    const shown = files.slice(-3);
    parts.push(`改动 ${shown.join(", ")}${files.length > shown.length ? ` 等 ${files.length} 个文件` : ""}`);
  }
  return `[harness] ${parts.join(" · ")}`;
}

/**
 * Attach the status line to the last tool result. A separate system/user message
 * would break the tool-call protocol (a tool message must follow an assistant
 * tool-call turn), so the tail of the last tool result is the safe place.
 */
export function appendStatus(content: string, line: string): string {
  if (!line) return content;
  return content ? `${content}\n\n${line}` : line;
}
