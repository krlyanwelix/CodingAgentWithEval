import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { formatMemoryBlock } from "./format.js";
import { MemoryService } from "./service.js";
import type { MemoryPort } from "./types.js";

export type { MemoryHit, MemoryKind, MemoryPort, RecallOptions, RememberInput, RememberResult } from "./types.js";
export { MemoryService } from "./service.js";
export { formatMemoryBlock } from "./format.js";
export { redactSecrets } from "./redact.js";
export { shouldRemember, summarizeTurn } from "./policy.js";

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Stable, human-readable scope for a checkout: `repo-1a2b3c4d`. */
export function projectIdFor(cwd: string): string {
  const root = resolve(cwd);
  const digest = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${basename(root) || "project"}-${digest}`;
}

/**
 * Build the memory client from the environment. The service may be remote
 * (`MEMORY_SERVICE_URL`) or spawned locally from memory-sidecar.py; either way
 * the agent only sees the MemoryPort interface.
 */
export function memoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): MemoryPort {
  return new MemoryService({
    baseUrl: env.MEMORY_SERVICE_URL ?? env.MEM0_URL ?? "http://127.0.0.1:8765",
    userId: env.MEMORY_USER_ID ?? "local-user",
    projectId: env.MEMORY_PROJECT_ID ?? projectIdFor(cwd),
    autoStart: env.MEMORY_AUTOSTART !== "0" && env.MEM0_AUTOSTART !== "false",
    pythonCommand: env.MEMORY_PYTHON ?? "python",
    serviceFile: env.MEMORY_SERVICE_FILE ?? "memory-sidecar.py",
    logFile: env.MEMORY_LOG ?? "data/memory-service.log",
    requestTimeoutMs: int(env.MEMORY_REQUEST_TIMEOUT_MS, 30_000),
    startTimeoutMs: int(env.MEMORY_START_TIMEOUT_MS, 20_000),
    limit: int(env.MEMORY_LIMIT, 5),
    minScore: num(env.MEMORY_MIN_SCORE, 0.35),
    budgetChars: int(env.MEMORY_BUDGET_CHARS, 900),
  });
}

/** Recall and render in one step; returns undefined when nothing relevant exists. */
export async function recallMemoryBlock(
  memory: MemoryPort,
  query: string,
  budgetChars = 900,
): Promise<string | undefined> {
  const hits = await memory.recall(query);
  return formatMemoryBlock(hits, budgetChars);
}
