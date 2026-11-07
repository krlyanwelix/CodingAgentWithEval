/**
 * Tool-error taxonomy.
 *
 * Tool results are strings, so the loop can only react to them by pattern. This
 * module centralises those patterns: one classification per failure, one concrete
 * corrective hint per class. "Unknown" gets no hint on purpose — guessing at a
 * fix for an unclassified error is how a small model starts thrashing.
 */

export type ToolErrorKind =
  | "not_found"
  | "permission"
  | "invalid_arguments"
  | "network"
  | "timeout"
  | "conflict"
  | "outside_workspace"
  | "unknown";

export interface ClassifiedError {
  kind: ToolErrorKind;
  hint?: string;
}

const PATTERNS: Array<{ kind: ToolErrorKind; pattern: RegExp; hint: string }> = [
  {
    kind: "outside_workspace",
    pattern: /outside the current working directory|path resolves outside/i,
    hint: "paths are relative to the workspace root; list the directory before reading a guessed name",
  },
  {
    kind: "not_found",
    pattern: /ENOENT|no such file|not found|cannot find|does not exist/i,
    hint: "confirm the path with glob or ls before retrying",
  },
  {
    kind: "permission",
    pattern: /EACCES|EPERM|permission denied|access is denied/i,
    hint: "the path is not writable by this process; work inside the workspace",
  },
  {
    kind: "invalid_arguments",
    pattern: /not valid JSON|arguments must|must be a (?:string|number|boolean)|oldText (?:was not found|must match)|path must be a non-empty/i,
    hint: "fix the arguments to match the schema before calling again",
  },
  {
    kind: "network",
    pattern: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up|network|fetch failed/i,
    hint: "the network or server is unavailable; do not retry the same request immediately",
  },
  {
    kind: "timeout",
    pattern: /timed out|timeout|ETIMEDOUT/i,
    hint: "narrow the command or raise timeoutMs instead of repeating it",
  },
  {
    kind: "conflict",
    pattern: /oldText must match exactly once|ambiguous/i,
    hint: "include more surrounding text so the edit matches exactly one place",
  },
];

export function classifyToolError(message: string): ClassifiedError {
  for (const entry of PATTERNS) {
    if (entry.pattern.test(message)) return { kind: entry.kind, hint: entry.hint };
  }
  return { kind: "unknown" };
}

/** True when the tool result is a failure the loop should count against the streak. */
export function isToolFailure(result: string): boolean {
  return result.startsWith("Tool error") || /^exit_code: (?!0)\d+/m.test(result) || result.startsWith("Tool not found");
}
