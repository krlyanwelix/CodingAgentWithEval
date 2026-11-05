import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Mem0Memory {
  id: string;
  memory?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Mem0ClientOptions {
  baseUrl?: string;
  userId: string;
  pythonCommand?: string;
  sidecarFile?: string;
  autoStart?: boolean;
  logFile?: string;
}

export class Mem0Client {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly pythonCommand: string;
  private readonly sidecarFile: string;
  private readonly autoStart: boolean;
  private readonly logFile: string;
  private sidecar?: ChildProcess;
  private available = false;
  private lastFailure?: string;
  private starting?: Promise<boolean>;

  constructor(options: Mem0ClientOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8765").replace(/\/$/, "");
    this.userId = options.userId;
    this.pythonCommand = options.pythonCommand ?? "python";
    this.sidecarFile = options.sidecarFile ?? "memory-sidecar.py";
    this.autoStart = options.autoStart ?? true;
    this.logFile = options.logFile ?? "data/mem0-sidecar.log";
  }

  start(): Promise<boolean> {
    this.starting ??= this.startSidecar().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startSidecar(): Promise<boolean> {
    if (await this.health()) {
      this.available = true;
      this.lastFailure = undefined;
      return true;
    }
    if (!this.autoStart) return false;
    if (this.sidecar && this.sidecar.exitCode === null) return this.waitForHealth(30);
    mkdirSync(dirname(this.logFile), { recursive: true });
    const log = (chunk: Buffer) => appendFileSync(this.logFile, chunk);
    this.sidecar = spawn(this.pythonCommand, [this.sidecarFile], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.sidecar.stdout?.on("data", log);
    this.sidecar.stderr?.on("data", log);
    this.sidecar.on("error", (error) => {
      this.lastFailure = `cannot start ${this.pythonCommand}: ${error.message}`;
      appendFileSync(this.logFile, `${new Date().toISOString()} ${this.lastFailure}\n`);
    });
    this.sidecar.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        this.lastFailure = `sidecar exited with code ${code}${signal ? ` (${signal})` : ""}`;
        appendFileSync(this.logFile, `${new Date().toISOString()} ${this.lastFailure}\n`);
      }
    });
    return this.waitForHealth(120);
  }

  private async waitForHealth(attempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await this.health()) {
        this.available = true;
        this.lastFailure = undefined;
        return true;
      }
      if (this.sidecar?.exitCode !== null && this.sidecar?.exitCode !== undefined) break;
    }
    this.lastFailure ??= `sidecar did not answer on ${this.baseUrl}/health`;
    return false;
  }

  /** Cheap re-check used by the server so memory recovers if the sidecar starts late. */
  async refresh(): Promise<boolean> {
    if (await this.health()) {
      this.available = true;
      return true;
    }
    this.available = false;
    return false;
  }

  isAvailable(): boolean { return this.available; }

  failureReason(): string | undefined { return this.lastFailure; }

  async add(messages: Array<{ role: string; content: string }>, runId?: string): Promise<unknown> {
    return this.request("/v1/memories/add", { messages, user_id: this.userId, run_id: runId });
  }

  async search(query: string, limit = 5): Promise<Mem0Memory[]> {
    const payload = await this.request("/v1/memories/search", { query, limit, user_id: this.userId }) as { results?: Mem0Memory[] };
    return payload.results ?? [];
  }

  async list(): Promise<Mem0Memory[]> {
    const payload = await this.request("/v1/memories/list", { user_id: this.userId }) as { results?: Mem0Memory[] };
    return payload.results ?? [];
  }

  async delete(memoryId: string): Promise<unknown> {
    return this.request("/v1/memories/delete", { memory_id: memoryId, user_id: this.userId });
  }

  async clear(): Promise<unknown> {
    return this.request("/v1/memories/clear", { user_id: this.userId });
  }

  close(): void {
    if (this.sidecar && this.sidecar.exitCode === null) this.sidecar.kill();
  }

  private async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch { return false; }
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.available && !(await this.refresh())) {
      const detail = this.lastFailure ? ` (${this.lastFailure})` : "";
      throw new Error(`Mem0 sidecar is unavailable${detail}. Install requirements-mem0.txt and restart the agent.`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Extraction calls the LLM and the embedding provider, so a 60s budget is too tight.
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) throw new Error(`Mem0 ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    return payload;
  }
}
