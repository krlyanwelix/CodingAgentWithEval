/**
 * DockerRuntime: the first `SandboxService` implementation.
 *
 * It wraps the Docker CLI (no SDK dependency). One container = one sandbox.
 * Everything Docker-specific lives here — the control plane only sees
 * `SandboxService`.
 *
 * Docker compromises documented in sandbox/README.md:
 * - pause/resume is `docker pause`/`unpause` (freeze, not a memory snapshot);
 * - endpoints are loopback port mappings (`127.0.0.1:<random>`);
 * - execd is baked into the runtime image by default (no bind mount).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SandboxError,
  type Endpoint,
  type PreparedSandbox,
  type RuntimeSandbox,
  type SandboxService,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface DockerRuntimeOptions {
  /**
   * Optional host directory with an execd binary to bind-mount at /opt/execd.
   * The default `lilpi-sandbox:local` image already contains execd, so this
   * exists only for iterating on execd without rebuilding the image.
   */
  execdDir?: string;
  dockerBin?: string;
  /** Command timeout for Docker CLI calls. */
  commandTimeoutMs?: number;
}

interface InspectResult {
  State?: { Status?: string; ExitCode?: number; Error?: string };
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string> };
}

function phaseOf(status: string | undefined): RuntimeSandbox["phase"] | undefined {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "created":
    case "restarting":
      return "created";
    case "exited":
    case "removing":
      return "exited";
    case "dead":
      return "dead";
    default:
      return undefined;
  }
}

export class DockerRuntime implements SandboxService {
  readonly name = "docker";
  private readonly bin: string;
  private readonly execdDir?: string;
  private readonly commandTimeoutMs: number;

  constructor(options: DockerRuntimeOptions = {}) {
    this.bin = options.dockerBin ?? process.env.DOCKER_BIN ?? "docker";
    this.execdDir = options.execdDir?.replace(/\\/g, "/");
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  }

  static containerName(id: string): string {
    return `lilpi-${id}`;
  }

  async create(sandbox: PreparedSandbox): Promise<void> {
    const ports = [...new Set([sandbox.execdPort, ...sandbox.ports])];
    const args = [
      "run",
      "-d",
      "--pull=missing",
      "--name",
      DockerRuntime.containerName(sandbox.id),
      "--label",
      "lilpi.sandbox=1",
      ...Object.entries(sandbox.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--env",
      `EXECD_ACCESS_TOKEN=${sandbox.token}`,
      "--env",
      "EXECD_ROOT=/workspace",
      "--env",
      `EXECD_PORT=${sandbox.execdPort}`,
      ...Object.entries(sandbox.env)
        .filter(([key]) => !key.startsWith("EXECD_"))
        .flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...ports.flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
      ...(this.execdDir
        ? ["--mount", `type=bind,source=${this.execdDir},target=/opt/execd,readonly`]
        : []),
      "--workdir",
      "/workspace",
      sandbox.image,
      ...sandbox.command,
    ];
    await this.docker(args);
  }

  async get(id: string): Promise<RuntimeSandbox | undefined> {
    let raw: string;
    try {
      raw = await this.docker([
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .}}",
        DockerRuntime.containerName(id),
      ]);
    } catch (error) {
      if (error instanceof SandboxError && /no such (object|container)/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
    const info = JSON.parse(raw) as InspectResult;
    const phase = phaseOf(info.State?.Status);
    if (!phase) {
      return { id, phase: "dead", error: `container state ${info.State?.Status ?? "unknown"}` };
    }
    const env = info.Config?.Env ?? [];
    const token = env
      .find((entry) => entry.startsWith("EXECD_ACCESS_TOKEN="))
      ?.slice("EXECD_ACCESS_TOKEN=".length);
    return {
      id,
      phase,
      error: info.State?.Error || undefined,
      image: info.Config?.Image,
      labels: info.Config?.Labels ?? {},
      token,
    };
  }

  async list(): Promise<RuntimeSandbox[]> {
    const output = await this.docker([
      "ps",
      "-a",
      "--filter",
      "label=lilpi.sandbox=1",
      "--format",
      '{{.Label "lilpi.sandbox.id"}}',
    ]);
    const ids = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const sandboxes: RuntimeSandbox[] = [];
    for (const id of ids) {
      const live = await this.get(id);
      if (live) sandboxes.push(live);
    }
    return sandboxes;
  }

  async delete(id: string): Promise<void> {
    try {
      await this.docker(["rm", "--force", DockerRuntime.containerName(id)]);
    } catch (error) {
      if (error instanceof SandboxError && /no such (object|container)/i.test(error.message)) {
        return;
      }
      throw error;
    }
  }

  async pause(id: string): Promise<void> {
    await this.docker(["pause", DockerRuntime.containerName(id)]);
  }

  async resume(id: string): Promise<void> {
    try {
      await this.docker(["unpause", DockerRuntime.containerName(id)]);
    } catch (error) {
      if (error instanceof SandboxError && /is not paused/i.test(error.message)) {
        throw new SandboxError("conflict", `sandbox ${id} is not paused`);
      }
      throw error;
    }
  }

  async getEndpoint(id: string, port: number): Promise<Endpoint | undefined> {
    let output: string;
    try {
      output = await this.docker(["port", DockerRuntime.containerName(id), `${port}/tcp`]);
    } catch (error) {
      if (error instanceof SandboxError && /no public port|is not running|no such/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
    for (const line of output.split(/\r?\n/)) {
      const match = /^(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(line.trim());
      if (match) return { port, url: `http://127.0.0.1:${match[1]}` };
    }
    return undefined;
  }

  /** Health probe used by tests and the e2e script. */
  async available(): Promise<boolean> {
    try {
      await this.docker(["version", "--format", "{{.Server.Version}}"], 15_000);
      return true;
    } catch {
      return false;
    }
  }

  private async docker(args: string[], timeoutMs = this.commandTimeoutMs): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.bin, args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean };
      if (failure.code === "ENOENT") {
        throw new SandboxError("unavailable", `docker CLI not found (${this.bin}); is Docker installed?`);
      }
      if (failure.killed) {
        throw new SandboxError("timeout", `docker ${args[0]} did not finish within ${timeoutMs}ms`);
      }
      const detail = (failure.stderr || failure.stdout || failure.message || "").trim().split(/\r?\n/)[0];
      throw new SandboxError("unavailable", `docker ${args[0]} failed: ${detail}`);
    }
  }
}
