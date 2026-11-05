/**
 * Sandbox platform contract.
 *
 * The control plane owns lifecycle policy (async create, TTL, pause/resume
 * rules) and talks to workloads only through `SandboxService`. A runtime
 * (Docker today, Firecracker/Kata later) must never leak its own API into the
 * control plane: adding a backend means adding one module, not editing routes.
 *
 * Rules every runtime must honour:
 * - `create` is asynchronous: it resolves once the workload exists, but the
 *   control plane exposes the sandbox as Pending until it is actually usable.
 * - Workload state is the source of truth. Nothing is stored in a database,
 *   and losing control-plane metadata must not corrupt a running sandbox.
 * - `resume` only revives a Paused workload. Terminated/Failed sandboxes are
 *   replaced, never revived in place.
 * - `getEndpoint` is the only sanctioned way to reach a service inside the
 *   sandbox. Callers never guess ports or URLs.
 */

export type SandboxState = "Pending" | "Running" | "Paused" | "Terminated" | "Failed";

/** What a caller may ask for when creating a sandbox. */
export interface SandboxSpec {
  /** Container image (runtime-specific default when omitted). */
  image?: string;
  /** Absolute lifetime in seconds, counted from creation. Never reset by pause. */
  ttlSeconds?: number;
  /** Extra environment variables visible to the workload. */
  env?: Record<string, string>;
  /** Extra container ports to publish on the host loopback (besides execd). */
  ports?: number[];
}

/** Lifecycle-normalised create request handed to a runtime. */
export interface PreparedSandbox {
  id: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  ports: number[];
  execdPort: number;
  token: string;
  /** Epoch milliseconds; absolute. */
  createdAt: number;
  expiresAt: number;
  labels: Record<string, string>;
}

/** The runtime view of one workload. `phase` is backend-specific material. */
export interface RuntimeSandbox {
  id: string;
  phase: "created" | "running" | "paused" | "exited" | "dead";
  error?: string;
  /** Image reported by the backend, when it can be read back. */
  image?: string;
  /** Labels written at create time, if the backend can return them. */
  labels?: Record<string, string>;
  /** execd token, recoverable from the workload so metadata stays disposable. */
  token?: string;
}

/** A reachable address for a port inside the sandbox. */
export interface Endpoint {
  port: number;
  url: string;
  /** Headers the caller must send (execd token), when the port needs auth. */
  headers?: Record<string, string>;
}

/** Public view of a sandbox. This is what HTTP clients see. */
export interface SandboxSnapshot {
  id: string;
  state: SandboxState;
  image: string;
  createdAt: string;
  expiresAt: string;
  error?: string;
  execdPort: number;
}

/**
 * Pluggable workload backend. Implementations: DockerRuntime (today).
 * Future: FirecrackerRuntime, KataRuntime, a pool-backed runtime.
 */
export interface SandboxService {
  readonly name: string;
  /** Start the workload. Resolves when it exists; does not wait for readiness. */
  create(sandbox: PreparedSandbox): Promise<void>;
  /** Current backend state, or undefined when the workload does not exist. */
  get(id: string): Promise<RuntimeSandbox | undefined>;
  list(): Promise<RuntimeSandbox[]>;
  /** Remove the workload. Must be idempotent. */
  delete(id: string): Promise<void>;
  /** Freeze a running workload (Docker: `docker pause`). */
  pause(id: string): Promise<void>;
  /** Thaw a paused workload. Only meaningful from Paused. */
  resume(id: string): Promise<void>;
  /** Resolve a reachable address for a container port. */
  getEndpoint(id: string, port: number): Promise<Endpoint | undefined>;
}

export type SandboxErrorCode =
  | "not_found"
  | "conflict"
  | "invalid"
  | "unsupported"
  | "unavailable"
  | "timeout";

const STATUS_BY_CODE: Record<SandboxErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  unsupported: 501,
  unavailable: 503,
  timeout: 504,
};

/** Error type shared by runtime, lifecycle and HTTP layers. */
export class SandboxError extends Error {
  readonly status: number;

  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
    this.status = STATUS_BY_CODE[code];
  }
}
