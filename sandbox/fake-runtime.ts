/**
 * In-memory `SandboxService` used by the lifecycle and HTTP tests.
 * It behaves like Docker: create resolves once the workload "exists", the
 * phase is readable afterwards, and nothing survives `delete`.
 */
import type { Endpoint, PreparedSandbox, RuntimeSandbox, SandboxService } from "./types.js";

export class FakeRuntime implements SandboxService {
  readonly name = "fake";
  readonly containers = new Map<string, RuntimeSandbox>();
  readonly deleted: string[] = [];
  /** Simulate slow container startup. */
  startDelayMs = 0;
  failWith?: string;

  async create(sandbox: PreparedSandbox): Promise<void> {
    this.containers.set(sandbox.id, {
      id: sandbox.id,
      phase: "created",
      labels: sandbox.labels,
      token: sandbox.token,
      image: sandbox.image,
    });
    if (this.startDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    }
    if (this.failWith) throw new Error(this.failWith);
    this.setPhase(sandbox.id, "running");
  }

  async get(id: string): Promise<RuntimeSandbox | undefined> {
    return this.containers.get(id);
  }

  async list(): Promise<RuntimeSandbox[]> {
    return [...this.containers.values()];
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    this.containers.delete(id);
  }

  async pause(id: string): Promise<void> {
    this.setPhase(id, "paused");
  }

  async resume(id: string): Promise<void> {
    this.setPhase(id, "running");
  }

  async getEndpoint(_id: string, port: number): Promise<Endpoint | undefined> {
    return port === 8765 ? { port, url: "http://127.0.0.1:40123" } : undefined;
  }

  setPhase(id: string, phase: RuntimeSandbox["phase"]): void {
    const existing = this.containers.get(id);
    if (existing) this.containers.set(id, { ...existing, phase });
  }
}
