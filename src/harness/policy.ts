/**
 * Capability and risk policy for tool calls.
 *
 * The agent is not "allowed to do anything the model asks": every call is
 * classified first, and the policy decides whether it can run, must be
 * confirmed, or is denied outright. Classification is deliberately conservative:
 * a false "high risk" costs one confirmation prompt, a false "low risk" can
 * delete the workspace.
 */

export type Capability = "fs.read" | "fs.write" | "shell" | "network" | "git.write";

export type Risk = "low" | "medium" | "high";

export interface CommandAssessment {
  risk: Risk;
  /** Human-readable reasons, e.g. "removes a path outside the workspace". */
  reasons: string[];
  /** Capabilities the command needs on top of "shell". */
  capabilities: Capability[];
  /** First token of each pipeline/&& segment, useful for tracing. */
  segments: string[];
}

export interface PolicyOptions {
  /** Capabilities the model may use. Default: everything (the user opted in). */
  allowedCapabilities?: Capability[];
  /**
   * Commands at or below this risk run without asking. "never" (default) keeps
   * the historical behaviour: every shell command asks first.
   */
  autoApproveRisk?: Risk | "never";
  /** Paths that always require confirmation before write/edit. */
  protectedPaths?: RegExp[];
}

export type Decision = "allow" | "ask" | "deny";

export interface PolicyDecision {
  decision: Decision;
  reason?: string;
  risk: Risk;
  capabilities: Capability[];
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function riskAtLeast(risk: Risk, threshold: Risk): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[threshold];
}

interface Rule {
  pattern: RegExp;
  risk: Risk;
  reason: string;
  capabilities?: Capability[];
}

/**
 * Command patterns worth stopping for. This is a cheap semantic pass, not a
 * parser: it runs on the raw string, after splitting off obvious pipes, so
 * `curl x | sh` is still visible as one command.
 */
const RULES: Rule[] = [
  // Destructive filesystem operations.
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$HOME\b)/, risk: "high", reason: "recursive delete of a home or root path" },
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\.\.(?:\/|\s|$)/, risk: "high", reason: "recursive delete of a parent directory" },
  { pattern: /\b(?:mkfs|fdisk|parted)\b/, risk: "high", reason: "formats or repartitions a disk" },
  { pattern: /\bdd\s+[^|]*\bof=\/dev\//, risk: "high", reason: "writes raw bytes to a device" },
  { pattern: />\s*\/dev\/(?:sd|nvme|hd)/, risk: "high", reason: "redirects output to a block device" },
  { pattern: /\bchmod\s+(?:-R\s+)?777\b/, risk: "high", reason: "makes a path world-writable" },
  { pattern: /\bchown\s+-R\b[^|]*\s(?:\/|~)/, risk: "high", reason: "recursively changes ownership of a system path" },

  // Irreversible version-control operations.
  { pattern: /\bgit\s+reset\s+--hard\b/, risk: "high", reason: "discards uncommitted work", capabilities: ["git.write"] },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdx][a-zA-Z]*\b/, risk: "high", reason: "deletes untracked files", capabilities: ["git.write"] },
  { pattern: /\bgit\s+push\s+(?:-f|--force)\b/, risk: "high", reason: "force-pushes shared history", capabilities: ["git.write", "network"] },
  { pattern: /\bgit\s+(?:push|commit|tag|merge|rebase|cherry-pick)\b/, risk: "medium", reason: "writes to version-control history", capabilities: ["git.write"] },

  // Remote code execution.
  { pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python\d?)\b/, risk: "high", reason: "pipes downloaded content into an interpreter", capabilities: ["network"] },
  { pattern: /\b(?:Invoke-Expression|iex)\s*[((]/, risk: "high", reason: "evaluates a string as code" },
  { pattern: /\bpowershell(?:\.exe)?\b[^|]*\s-(?:enc|encodedcommand)\b/i, risk: "high", reason: "runs base64-encoded PowerShell" },
  { pattern: /\b(?:certutil|bitsadmin)\b[^|]*-urlcache\b/i, risk: "high", reason: "downloads a payload with a signed binary" },

  // System control.
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/, risk: "high", reason: "shuts down the machine" },
  { pattern: /\btaskkill\b[^|]*\/f\b/i, risk: "high", reason: "force-kills a process" },
  { pattern: /\b(?:net\s+user|reg\s+add|sc\s+create)\b/i, risk: "high", reason: "changes system accounts or services" },
  { pattern: /:\(\)\s*\{.*\};\s*:/, risk: "high", reason: "fork bomb" },

  // Network egress and installs.
  { pattern: /\b(?:npm|pnpm|yarn)\s+(?:publish|install|add|i)\b/, risk: "medium", reason: "installs or publishes packages", capabilities: ["network"] },
  { pattern: /\bpip3?\s+install\b/, risk: "medium", reason: "installs Python packages", capabilities: ["network"] },
  { pattern: /\bgit\s+(?:clone|fetch|pull)\b/, risk: "medium", reason: "fetches remote code", capabilities: ["network", "git.write"] },
  { pattern: /\b(?:curl|wget|ssh|scp|rsync|nc|ncat|telnet)\b/, risk: "medium", reason: "uses the network", capabilities: ["network"] },
  { pattern: /\bnode\s+(?:-e|--eval)\b|\bpython\d?\s+-c\b|\bperl\s+-e\b/, risk: "medium", reason: "runs inline code" },

  // Writes outside the obvious.
  { pattern: /(?:^|\s)(?:>|>>)\s*(?:\/|~\/|[A-Za-z]:\\)/, risk: "medium", reason: "redirects output to an absolute path", capabilities: ["fs.write"] },
  { pattern: /\b(?:rm|mv|cp|mkdir|touch|tee|truncate)\b/, risk: "low", reason: "writes to the filesystem", capabilities: ["fs.write"] },
  { pattern: /\bsed\s+-i\b/, risk: "low", reason: "edits files in place", capabilities: ["fs.write"] },
];

/** Split on pipes and list separators only to report segments; rules see the whole string. */
function segmentsOf(command: string): string[] {
  return command
    .split(/\|\||&&|;|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstWord(segment: string): string {
  return segment.split(/\s+/)[0] ?? "";
}

/** Classify one shell command. Unknown commands are "low": asking on everything is noise. */
export function assessCommand(command: string): CommandAssessment {
  const reasons: string[] = [];
  const capabilities = new Set<Capability>();
  let risk: Risk = "low";

  for (const rule of RULES) {
    if (!rule.pattern.test(command)) continue;
    risk = maxRisk(risk, rule.risk);
    reasons.push(rule.reason);
    for (const capability of rule.capabilities ?? []) capabilities.add(capability);
  }

  // A pipeline that sends environment or dotfiles to the network is exfiltration.
  if (/\b(?:env|printenv|cat\s+\.env)\b[^|]*\|\s*(?:curl|wget|nc|ssh)\b/.test(command)) {
    risk = "high";
    reasons.push("pipes environment data to the network");
    capabilities.add("network");
  }

  const segments = segmentsOf(command);
  return {
    risk,
    reasons: [...new Set(reasons)],
    capabilities: [...capabilities],
    segments,
  };
}

const PROTECTED_DEFAULT = [/^\.env(?:\.|$)/i, /(?:^|[\\/])\.env(?:\.|$)/i, /(?:^|[\\/])\.git[\\/]/i, /\.pem$|\.key$|id_rsa/i];

function pathOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

export interface ToolLike {
  definition: { name: string };
}

/**
 * Decide what to do with one tool call. The agent applies this before asking the
 * user; eval harnesses can pass `autoApproveRisk: "high"` to run unattended.
 */
export function evaluateToolCall(
  toolName: string,
  args: unknown,
  options: PolicyOptions = {},
): PolicyDecision {
  const allowed = new Set<Capability>(options.allowedCapabilities ?? ["fs.read", "fs.write", "shell", "network", "git.write"]);
  const autoApprove = options.autoApproveRisk ?? "never";
  const protectedPaths = options.protectedPaths ?? PROTECTED_DEFAULT;

  if (toolName === "bash") {
    const command = typeof args === "object" && args !== null ? String((args as { command?: unknown }).command ?? "") : "";
    const assessment = assessCommand(command);
    const needed = ["shell", ...assessment.capabilities] as Capability[];
    const missing = needed.filter((capability) => !allowed.has(capability));
    if (missing.length > 0) {
      return {
        decision: "deny",
        reason: `command needs ${missing.join(", ")}, which this session does not allow`,
        risk: assessment.risk,
        capabilities: assessment.capabilities,
      };
    }
    const reason = assessment.reasons.length > 0 ? assessment.reasons.join("; ") : undefined;
    if (autoApprove !== "never" && riskAtLeast(autoApprove, assessment.risk)) {
      return { decision: "allow", reason, risk: assessment.risk, capabilities: assessment.capabilities };
    }
    return { decision: "ask", reason, risk: assessment.risk, capabilities: assessment.capabilities };
  }

  if (toolName === "write" || toolName === "edit") {
    if (!allowed.has("fs.write")) {
      return { decision: "deny", reason: "file writes are disabled in this session", risk: "medium", capabilities: ["fs.write"] };
    }
    const path = pathOf(args);
    if (path && protectedPaths.some((pattern) => pattern.test(path))) {
      return { decision: "ask", reason: "path is protected", risk: "medium", capabilities: ["fs.write"] };
    }
    return { decision: "allow", risk: "low", capabilities: ["fs.write"] };
  }

  return { decision: "allow", risk: "low", capabilities: [] };
}

/** Short label for a decision, used in trace records and error results. */
export function describeDecision(decision: PolicyDecision): string {
  const parts: string[] = [decision.risk];
  if (decision.reason) parts.push(decision.reason);
  return parts.join(": ");
}
