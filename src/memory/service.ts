import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { shouldRemember } from "./policy.js";
import { capText, normalizeMemoryText, redactSecrets } from "./redact.js";
import type {
  MemoryHealth,
  MemoryHit,
  MemoryKind,
  MemoryPort,
  RecallOptions,
  RememberInput,
  RememberResult,
} from "./types.js";

/**
 * Thin client for the standalone memory service (memory-sidecar.py).
 *
 * Design rules:
 * - fail open: memory is an optimisation, never a prerequisite for a turn;
 * - bounded: every HTTP call has a deadline, and a failed service backs off
 *   instead of adding latency to every prompt;
 * - redact on the way out: secrets are stripped before they leave the process,
 *   the service redacts again.
 */

export interface MemoryServiceOptions {
  baseUrl?: string;
  userId: string;
  projectId?: string;
  autoStart?: boolean;
  pythonCommand?: string;
  serviceFile?: string;
  logFile?: string;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  limit?: number;
  minScore?: number;
  budgetChars?: number;
  inferByDefault?: boolean;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
}

interface RawHit {
  id?: string;
  text?: string;
  memory?: string;
  content?: string;
  score?: number;
  created_at?: string;
  createdAt?: string;
  kind?: string;
  project_id?: string;
}

interface SearchPayload {
  hits?: RawHit[];
  results?: RawHit[];
  used_chars?: number;
}

interface WritePayload {
  written?: Array<{ id?: string; text?: string }>;
  skipped?: Array<{ reason?: string } | string>;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_BUDGET_CHARS = 900;
const MAX_WRITE_CHARS = 2000;
const RETRY_AFTER_FAILURE_MS = 30_000;

function asKind(value: string | undefined): MemoryKind | undefined {
  return value === "fact" || value === "preference" || value === "decision" || value === "note"
    ? value
    : undefined;
}

function toHit(raw: RawHit): MemoryHit | undefined {
  const text = (raw.text ?? raw.memory ?? raw.content ?? "").toString().trim();
  if (!raw.id || !text) return undefined;
  return {
    id: raw.id,
    text,
    score: typeof raw.score === "number" ? raw.score : 0,
    createdAt: raw.created_at ?? raw.createdAt,
    kind: asKind(raw.kind),
    projectId: raw.project_id,
  };
}

export class MemoryService implements MemoryPort {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly projectId?: string;
  private readonly autoStart: boolean;
  private readonly pythonCommand: string;
  private readonly serviceFile: string;
  private readonly logFile: string;
  private readonly requestTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly defaultLimit: number;
  private readonly defaultMinScore: number;
  private readonly defaultBudgetChars: number;
  private readonly inferByDefault: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly warn: (message: string) => void;

  private sidecar?: ChildProcess;
  private available = false;
  private lastFailure?: string;
  private starting?: Promise<boolean>;
  private retryAt = 0;
  private warned = new Set<string>();

  constructor(options: MemoryServiceOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8765").replace(/\/$/, "");
    this.userId = options.userId;
    this.projectId = options.projectId;
    this.autoStart = options.autoStart ?? true;
    this.pythonCommand = options.pythonCommand ?? "python";
    this.serviceFile = options.serviceFile ?? "memory-sidecar.py";
    this.logFile = options.logFile ?? "data/memory-service.log";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.defaultLimit = options.limit ?? DEFAULT_LIMIT;
    this.defaultMinScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.defaultBudgetChars = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
    this.inferByDefault = options.inferByDefault ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  get enabled(): boolean {
    return this.available;
  }

  failureReason(): string | undefined {
    return this.lastFailure;
  }

  start(): Promise<boolean> {
    this.starting ??= this.startService().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startService(): Promise<boolean> {
    if (await this.check()) return true;
    if (!this.autoStart) return false;
    if (this.sidecar && this.sidecar.exitCode === null) return this.waitForHealth();
    mkdirSync(dirname(this.logFile), { recursive: true });
    const log = (chunk: Buffer) => appendFileSync(this.logFile, chunk);
    try {
      this.sidecar = spawn(this.pythonCommand, [this.serviceFile], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.lastFailure = `cannot start ${this.pythonCommand}: ${error instanceof Error ? error.message : String(error)}`;
      this.note("spawn", this.lastFailure);
      return false;
    }
    this.sidecar.stdout?.on("data", log);
    this.sidecar.stderr?.on("data", log);
    this.sidecar.on("error", (error) => {
      this.lastFailure = `cannot start ${this.pythonCommand}: ${error.message}`;
      this.note("spawn", this.lastFailure);
    });
    this.sidecar.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        this.lastFailure = `memory service exited with code ${code}${signal ? ` (${signal})` : ""}`;
        this.note("exit", this.lastFailure);
        this.available = false;
      }
    });
    return this.waitForHealth();
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (await this.check()) return true;
      if (this.sidecar && this.sidecar.exitCode !== null) break;
    }
    this.lastFailure ??= `memory service did not answer on ${this.baseUrl}/health`;
    this.note("health", this.lastFailure);
    return false;
  }

  /** Cheap re-check; backs off for 30s after a failure so a dead service costs nothing. */
  async refresh(): Promise<boolean> {
    if (this.available) return true;
    if (Date.now() < this.retryAt) return false;
    const ok = await this.check();
    if (!ok) this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    return ok;
  }

  async health(): Promise<MemoryHealth> {
    const ok = await this.refresh();
    return ok ? { ok: true } : { ok: false, error: this.lastFailure };
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (!(await this.refresh())) return [];
    try {
      const payload = (await this.request("/v1/memories/search", {
        query: capText(trimmed, 2000),
        user_id: this.userId,
        project_id: this.projectId,
        limit: options.limit ?? this.defaultLimit,
        min_score: options.minScore ?? this.defaultMinScore,
        budget_chars: options.budgetChars ?? this.defaultBudgetChars,
      })) as SearchPayload;
      const raw = payload.hits ?? payload.results ?? [];
      return raw.map(toHit).filter((hit): hit is MemoryHit => hit !== undefined);
    } catch (error) {
      this.degrade("recall", error);
      return [];
    }
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    if (!(await this.refresh())) return { written: 0, skipped: ["memory service unavailable"] };
    const infer = input.infer ?? this.inferByDefault;
    let body: Record<string, unknown>;
    if (input.text !== undefined) {
      const clean = capText(normalizeMemoryText(redactSecrets(input.text).text), MAX_WRITE_CHARS);
      if (!clean) return { written: 0, skipped: ["empty text"] };
      body = { text: clean, infer: false };
    } else if (input.messages && input.messages.length > 0) {
      const messages = input.messages
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({ role: message.role, content: redactSecrets(message.content).text }));
      if (messages.length === 0) return { written: 0, skipped: ["empty messages"] };
      if (infer && !shouldRemember(messages.map((message) => message.content).join("\n"))) {
        return { written: 0, skipped: ["turn carries nothing durable"] };
      }
      body = { messages, infer };
    } else {
      return { written: 0, skipped: ["no content"] };
    }

    try {
      const payload = (await this.request("/v1/memories", {
        ...body,
        user_id: this.userId,
        project_id: this.projectId,
        session_id: input.sessionId,
        kind: input.kind,
        ttl_days: input.ttlDays,
      })) as WritePayload;
      const written = (payload.written ?? []).length;
      const skipped = (payload.skipped ?? []).map((item) =>
        typeof item === "string" ? item : item.reason ?? "skipped",
      );
      return { written, skipped };
    } catch (error) {
      this.degrade("remember", error);
      return { written: 0, skipped: ["memory service error"] };
    }
  }

  async list(limit = 50): Promise<MemoryHit[]> {
    if (!(await this.refresh())) return [];
    try {
      const params = new URLSearchParams({ user_id: this.userId, limit: String(limit) });
      if (this.projectId) params.set("project_id", this.projectId);
      const payload = (await this.request(`/v1/memories?${params.toString()}`, undefined, "GET")) as SearchPayload;
      return (payload.hits ?? payload.results ?? []).map(toHit).filter((hit): hit is MemoryHit => hit !== undefined);
    } catch (error) {
      this.degrade("list", error);
      return [];
    }
  }

  async forget(id: string): Promise<void> {
    if (!(await this.refresh())) throw new Error("memory service unavailable");
    const params = new URLSearchParams({ user_id: this.userId });
    await this.request(`/v1/memories/${encodeURIComponent(id)}?${params.toString()}`, undefined, "DELETE");
  }

  async clear(): Promise<void> {
    if (!(await this.refresh())) throw new Error("memory service unavailable");
    await this.request("/v1/memories/clear", { user_id: this.userId, project_id: this.projectId });
  }

  close(): void {
    if (this.sidecar && this.sidecar.exitCode === null) this.sidecar.kill();
  }

  private async check(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const payload = (await response.json().catch(() => ({}))) as { status?: string };
      // "degraded" means the process is up but the backend failed to initialise.
      const ok = payload.status !== "degraded";
      this.available = ok;
      if (ok) {
        this.lastFailure = undefined;
        this.retryAt = 0;
      }
      return ok;
    } catch {
      this.available = false;
      return false;
    }
  }

  private async request(path: string, body?: Record<string, unknown>, method = "POST"): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(`memory service ${response.status}: ${detail}`);
    }
    return payload;
  }

  private degrade(operation: string, error: unknown): void {
    this.available = false;
    this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    this.lastFailure = error instanceof Error ? error.message : String(error);
    this.note(operation, this.lastFailure);
  }

  private note(scope: string, message: string): void {
    const key = `${scope}:${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(`Long-term memory (${scope}): ${message}`);
  }
}
