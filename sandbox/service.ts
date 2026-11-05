/**
 * Lifecycle service: the control plane's policy layer.
 *
 * It owns the state machine, asynchronous creation, absolute TTL and the
 * pause/resume rules, but it knows nothing about containers. All workload
 * operations go through `SandboxService`.
 *
 * State machine:
 *
 *   Pending ──► Running ──► Paused ──► Running
 *      │           │           │
 *      └───────────┴───────────┴──► Terminated (deleted or expired TTL)
 *      └──► Failed (backend refused to start)
 *
 * Transitions are one-way except pause/resume. A Terminated or Failed sandbox
 * must be deleted and recreated; resume never resurrects it.
 */
import { randomBytes } from "node:crypto";
import type { MetadataStore, SandboxRecord } from "./metadata.js";
import {
  SandboxError,
  type Endpoint,
  type PreparedSandbox,
  type RuntimeSandbox,
  type SandboxService,
  type SandboxSnapshot,
  type SandboxSpec,
  type SandboxState,
} from "./types.js";

export interface LifecycleServiceOptions {
  runtime: SandboxService;
  metadata: MetadataStore;
  defaultImage?: string;
  /** Entrypoint that starts the in-sandbox data plane. */
  execdCommand?: string[];
  defaultTtlSeconds?: number;
  ttlSweepMs?: number;
  /** Injectable for tests. */
  clock?: () => number;
  /** Override the "data plane is answering" probe used by waitReady. */
  dataPlaneProbe?: (endpoint: Endpoint) => Promise<boolean>;
}

interface StateEntry {
  state: SandboxState;
  error?: string;
}

const DEFAULT_IMAGE = "python:3.12-slim";
const DEFAULT_TTL_SECONDS = 600;

/** Ready means the agent can run commands: execd answers /ping with the token. */
async function pingEndpoint(endpoint: Endpoint): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.url}/ping`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function phaseToState(phase: RuntimeSandbox["phase"]): SandboxState {
  switch (phase) {
    case "created":
      return "Pending";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "exited":
      return "Terminated";
    case "dead":
      return "Failed";
  }
}

export class LifecycleService {
  private readonly runtime: SandboxService;
  private readonly metadata: MetadataStore;
  private readonly defaultImage: string;
  private readonly execdCommand: string[];
  private readonly defaultTtlSeconds: number;
  private readonly clock: () => number;
  private readonly dataPlaneProbe: (endpoint: Endpoint) => Promise<boolean>;
  private readonly states = new Map<string, StateEntry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(options: LifecycleServiceOptions) {
    this.runtime = options.runtime;
    this.metadata = options.metadata;
    this.defaultImage = options.defaultImage ?? DEFAULT_IMAGE;
    this.execdCommand = options.execdCommand ?? ["python3", "/opt/execd/execd.py"];
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    this.clock = options.clock ?? Date.now;
    this.dataPlaneProbe = options.dataPlaneProbe ?? pingEndpoint;
    this.sweeper = setInterval(() => {
      void this.sweepExpired();
    }, options.ttlSweepMs ?? 2_000);
    this.sweeper.unref();
  }

  /**
   * Accept the request and start the workload in the background. The returned
   * snapshot is always Pending: callers poll `get` or await `waitReady`.
   */
  async create(spec: SandboxSpec = {}): Promise<SandboxSnapshot> {
    const ttlSeconds = spec.ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new SandboxError("invalid", "ttlSeconds must be a positive number");
    }
    for (const port of spec.ports ?? []) {
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new SandboxError("invalid", `invalid port: ${port}`);
      }
    }

    const createdAt = this.clock();
    const record: SandboxRecord = {
      id: `sbx-${randomBytes(6).toString("hex")}`,
      image: spec.image ?? this.defaultImage,
      createdAt,
      expiresAt: createdAt + ttlSeconds * 1000,
      execdPort: 8765,
      token: randomBytes(24).toString("base64url"),
      labels: {},
    };
    record.labels = {
      "lilpi.sandbox.id": record.id,
      "lilpi.sandbox.image": record.image,
      "lilpi.sandbox.created": String(record.createdAt),
      "lilpi.sandbox.expires": String(record.expiresAt),
      "lilpi.sandbox.execd": String(record.execdPort),
    };

    const prepared: PreparedSandbox = {
      id: record.id,
      image: record.image,
      command: this.execdCommand,
      env: { ...spec.env },
      ports: [...(spec.ports ?? [])],
      execdPort: record.execdPort,
      token: record.token,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      labels: record.labels,
    };

    this.metadata.put(record);
    this.states.set(record.id, { state: "Pending" });
    // Defer so the HTTP response (Pending) leaves before the backend runs.
    setTimeout(() => {
      void this.start(prepared);
    }, 0);
    return this.snapshot(record);
  }

  private async start(prepared: PreparedSandbox): Promise<void> {
    try {
      await this.runtime.create(prepared);
      const live = await this.runtime.get(prepared.id);
      if (!live) {
        this.fail(prepared.id, "workload disappeared right after create");
        return;
      }
      this.states.set(prepared.id, { state: phaseToState(live.phase), error: live.error });
    } catch (error) {
      this.fail(prepared.id, error instanceof Error ? error.message : String(error));
    }
  }

  private fail(id: string, message: string): void {
    this.states.set(id, { state: "Failed", error: message });
  }

  async get(id: string): Promise<SandboxSnapshot | undefined> {
    const record = this.metadata.get(id) ?? (await this.rebuildRecord(id));
    if (!record) return undefined;
    const derived = this.states.get(id) ? undefined : await this.deriveState(id);
    const state = this.states.get(id) ?? derived ?? { state: "Terminated" as const };
    return this.snapshot(record, state);
  }

  async list(): Promise<SandboxSnapshot[]> {
    await this.adoptOrphans();
    const snapshots: SandboxSnapshot[] = [];
    for (const record of this.metadata.list()) {
      const state = this.states.get(record.id) ?? (await this.deriveState(record.id)) ?? { state: "Terminated" };
      snapshots.push(this.snapshot(record, state));
    }
    return snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(id: string): Promise<void> {
    const record = this.metadata.get(id);
    if (!record) throw new SandboxError("not_found", `sandbox ${id} does not exist`);
    await this.runtime.delete(id);
    this.metadata.delete(id);
    this.states.set(id, { state: "Terminated", error: "deleted" });
  }

  async pause(id: string): Promise<SandboxSnapshot> {
    const record = await this.requireRecord(id);
    const state = await this.currentState(id);
    if (state !== "Running") {
      throw new SandboxError("conflict", `sandbox ${id} is ${state}; only a Running sandbox can be paused`);
    }
    await this.runtime.pause(id);
    this.states.set(id, { state: "Paused" });
    return this.snapshot(record, this.states.get(id));
  }

  async resume(id: string): Promise<SandboxSnapshot> {
    const record = await this.requireRecord(id);
    const state = await this.currentState(id);
    if (state === "Terminated" || state === "Failed") {
      throw new SandboxError(
        "conflict",
        `sandbox ${id} is ${state}; create a replacement instead of resuming it`,
      );
    }
    if (state !== "Paused") {
      throw new SandboxError("conflict", `sandbox ${id} is ${state}; only a Paused sandbox can be resumed`);
    }
    await this.runtime.resume(id);
    this.states.set(id, { state: "Running" });
    return this.snapshot(record, this.states.get(id));
  }

  async getEndpoint(id: string, port: number): Promise<Endpoint> {
    const record = await this.requireRecord(id);
    const state = await this.currentState(id);
    if (state !== "Running") {
      throw new SandboxError("conflict", `sandbox ${id} is ${state}; endpoints are only resolvable while Running`);
    }
    const endpoint = await this.runtime.getEndpoint(id, port);
    if (!endpoint) {
      throw new SandboxError("not_found", `sandbox ${id} does not expose port ${port}`);
    }
    if (port === record.execdPort) {
      endpoint.headers = { "X-EXECD-ACCESS-TOKEN": record.token };
    }
    return endpoint;
  }

  /** Poll until Running *and* the data plane answers, fail fast, or time out. */
  async waitReady(id: string, timeoutMs = 30_000): Promise<SandboxSnapshot> {
    const deadline = this.clock() + timeoutMs;
    for (;;) {
      const snapshot = await this.get(id);
      if (!snapshot) throw new SandboxError("not_found", `sandbox ${id} does not exist`);
      if (snapshot.state === "Failed" || snapshot.state === "Terminated") {
        const detail = snapshot.error ? `: ${snapshot.error}` : "";
        throw new SandboxError("conflict", `sandbox ${id} is ${snapshot.state}${detail}`);
      }
      if (snapshot.state === "Running" && (await this.isDataPlaneReady(snapshot))) {
        return snapshot;
      }
      if (this.clock() >= deadline) {
        const detail =
          snapshot.state === "Running"
            ? `sandbox ${id} is Running but its execd agent is not answering on port ${snapshot.execdPort}`
            : `sandbox ${id} is still ${snapshot.state} after ${timeoutMs}ms`;
        throw new SandboxError("timeout", detail);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async isDataPlaneReady(snapshot: SandboxSnapshot): Promise<boolean> {
    try {
      const endpoint = await this.getEndpoint(snapshot.id, snapshot.execdPort);
      return await this.dataPlaneProbe(endpoint);
    } catch {
      return false;
    }
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  private async sweepExpired(): Promise<void> {
    const now = this.clock();
    for (const record of this.metadata.list()) {
      if (record.expiresAt > now) continue;
      const state = this.states.get(record.id)?.state;
      if (state === "Terminated" || state === "Failed") continue;
      try {
        await this.runtime.delete(record.id);
      } catch {
        // The workload may already be gone; expiry still wins.
      }
      this.states.set(record.id, { state: "Terminated", error: "expired" });
    }
  }

  private async currentState(id: string): Promise<SandboxState> {
    const cached = this.states.get(id);
    if (cached) return cached.state;
    const derived = await this.deriveState(id);
    if (derived) {
      this.states.set(id, derived);
      return derived.state;
    }
    return "Terminated";
  }

  private async deriveState(id: string): Promise<StateEntry | undefined> {
    const live = await this.runtime.get(id);
    if (!live) return { state: "Terminated" };
    return { state: phaseToState(live.phase), error: live.error };
  }

  /**
   * Rebuild a record from the backend. The workload is the source of truth;
   * labels carry the deadline, so a lost metadata file stays recoverable.
   */
  private async rebuildRecord(id: string): Promise<SandboxRecord | undefined> {
    const live = await this.runtime.get(id);
    if (!live) return undefined;
    const labels = live.labels ?? {};
    const createdAt = Number(labels["lilpi.sandbox.created"]) || this.clock();
    const expiresAt =
      Number(labels["lilpi.sandbox.expires"]) || createdAt + this.defaultTtlSeconds * 1000;
    const record: SandboxRecord = {
      id,
      image: live.image ?? labels["lilpi.sandbox.image"] ?? this.defaultImage,
      createdAt,
      expiresAt,
      execdPort: Number(labels["lilpi.sandbox.execd"]) || 8765,
      token: live.token ?? "",
      labels,
    };
    this.metadata.put(record);
    this.states.set(id, { state: phaseToState(live.phase), error: live.error });
    return record;
  }

  /** Adopt workloads that exist in the backend but not in metadata. */
  private async adoptOrphans(): Promise<void> {
    const known = new Set(this.metadata.list().map((record) => record.id));
    for (const live of await this.runtime.list()) {
      if (known.has(live.id)) continue;
      await this.rebuildRecord(live.id);
    }
  }

  private async requireRecord(id: string): Promise<SandboxRecord> {
    const record = this.metadata.get(id);
    if (!record) throw new SandboxError("not_found", `sandbox ${id} does not exist`);
    return record;
  }

  private snapshot(record: SandboxRecord, state: StateEntry = { state: "Pending" }): SandboxSnapshot {
    return {
      id: record.id,
      state: state.state,
      image: record.image,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      error: state.error,
      execdPort: record.execdPort,
    };
  }

  /** Expose the deadline helper used by tests and docs. */
  static remainingSeconds(snapshot: SandboxSnapshot, now = Date.now()): number {
    return Math.max(0, Math.round((Date.parse(snapshot.expiresAt) - now) / 1000));
  }
}
