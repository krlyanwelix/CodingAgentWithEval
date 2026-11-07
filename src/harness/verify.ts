import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findBash } from "../tools.js";

const execFileAsync = promisify(execFile);

/**
 * Completion verification.
 *
 * "The model said it is done" is not evidence. When a verification gate is
 * configured, the harness runs the checks itself and only lets the run finish
 * when they pass. Checks are shell commands with a stable name, so the failure
 * message can point at the exact check that failed.
 */

export interface VerifyCheck {
  name: string;
  command: string;
  /** Default 60s: verification should be quick or it becomes the bottleneck. */
  timeoutMs?: number;
}

export interface VerifyResult {
  name: string;
  pass: boolean;
  /** Combined stdout/stderr, head-truncated. */
  output: string;
}

export interface VerificationOptions {
  checks: VerifyCheck[];
  /** How many times a failed answer may be sent back for repair. Default 1. */
  maxAttempts?: number;
}

/** Run every check in order; a failing check does not abort the remaining ones. */
export async function runVerification(
  directory: string,
  checks: VerifyCheck[],
  signal?: AbortSignal,
): Promise<VerifyResult[]> {
  const bash = findBash();
  const results: VerifyResult[] = [];
  for (const check of checks) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    if (!bash) {
      results.push({ name: check.name, pass: false, output: "Git Bash was not found; cannot run verification checks." });
      continue;
    }
    try {
      const result = await execFileAsync(bash, ["-lc", check.command], {
        cwd: directory,
        timeout: check.timeoutMs ?? 60_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        signal,
      });
      const output = `${result.stdout ?? ""}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`.trim();
      results.push({ name: check.name, pass: true, output: cap(output) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const error = cause as { stdout?: string; stderr?: string; code?: string | number; killed?: boolean; message?: string };
      const output = [
        error.stdout,
        error.stderr ? `stderr:\n${error.stderr}` : "",
        `exit_code: ${error.code ?? "unknown"}${error.killed ? " (timed out)" : ""}`,
        !error.stdout && !error.stderr ? error.message : "",
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
      results.push({ name: check.name, pass: false, output: cap(output) });
    }
  }
  return results;
}

function cap(output: string, limit = 1200): string {
  if (output.length <= limit) return output;
  return `${output.slice(0, limit)}\n... [verification output truncated]`;
}

/** A compact corrective message the model can act on, not a wall of logs. */
export function formatVerificationFailure(results: VerifyResult[]): string {
  const lines = results
    .filter((result) => !result.pass)
    .map((result) => `- ${result.name} failed:\n${indent(result.output)}`);
  return `[harness] 验证未通过，不能结束：\n${lines.join("\n")}\n请修复失败项后重新运行验证，不要只改测试或谎报结果。`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .slice(0, 20)
    .map((line) => `  ${line}`)
    .join("\n");
}
