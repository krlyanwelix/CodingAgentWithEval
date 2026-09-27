import { spawn, type ChildProcess } from "node:child_process";

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
}

export class Mem0Client {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly pythonCommand: string;
  private readonly sidecarFile: string;
  private readonly autoStart: boolean;
  private sidecar?: ChildProcess;
  private available = false;

  constructor(options: Mem0ClientOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8765").replace(/\/$/, "");
    this.userId = options.userId;
    this.pythonCommand = options.pythonCommand ?? "python";
    this.sidecarFile = options.sidecarFile ?? "memory-sidecar.py";
    this.autoStart = options.autoStart ?? true;
  }

  async start(): Promise<boolean> {
    if (await this.health()) return (this.available = true);
    if (!this.autoStart) return false;
    this.sidecar = spawn(this.pythonCommand, [this.sidecarFile], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await this.health()) return (this.available = true);
      if (this.sidecar.exitCode !== null) break;
    }
    return false;
  }

  isAvailable(): boolean { return this.available; }

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
    if (!this.available) throw new Error("Mem0 sidecar is unavailable. Install requirements-mem0.txt and restart the agent.");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) throw new Error(`Mem0 ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    return payload;
  }
}
