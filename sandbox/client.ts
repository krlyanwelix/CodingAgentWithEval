/**
 * Typed clients for the two planes:
 * - `ControlPlaneClient` — HTTP API (create/list/get/delete/pause/resume/…);
 * - `ExecdClient` — the in-sandbox data plane over the resolved endpoint.
 *
 * The agent itself would use these same two clients: control plane for
 * lifecycle, execd for commands and files.
 */
import { SandboxError, type Endpoint, type SandboxSnapshot, type SandboxSpec } from "./types.js";

export class ControlPlaneClient {
  readonly baseUrl: string;

  constructor(options: { baseUrl?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.SANDBOX_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
  }

  async create(spec: SandboxSpec = {}): Promise<SandboxSnapshot> {
    const body = await this.request<{ sandbox: SandboxSnapshot }>("POST", "/sandboxes", spec);
    return body.sandbox;
  }

  async get(id: string): Promise<SandboxSnapshot | undefined> {
    try {
      const body = await this.request<{ sandbox: SandboxSnapshot }>("GET", `/sandboxes/${encodeURIComponent(id)}`);
      return body.sandbox;
    } catch (error) {
      if (error instanceof SandboxError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  async list(): Promise<SandboxSnapshot[]> {
    const body = await this.request<{ sandboxes: SandboxSnapshot[] }>("GET", "/sandboxes");
    return body.sandboxes;
  }

  async delete(id: string): Promise<void> {
    await this.request<void>("DELETE", `/sandboxes/${encodeURIComponent(id)}`);
  }

  async pause(id: string): Promise<SandboxSnapshot> {
    const body = await this.request<{ sandbox: SandboxSnapshot }>("POST", `/sandboxes/${encodeURIComponent(id)}/pause`);
    return body.sandbox;
  }

  async resume(id: string): Promise<SandboxSnapshot> {
    const body = await this.request<{ sandbox: SandboxSnapshot }>("POST", `/sandboxes/${encodeURIComponent(id)}/resume`);
    return body.sandbox;
  }

  async endpoint(id: string, port: number): Promise<Endpoint> {
    const body = await this.request<{ endpoint: Endpoint }>(
      "GET",
      `/sandboxes/${encodeURIComponent(id)}/endpoints/${port}`,
    );
    return body.endpoint;
  }

  async waitReady(id: string, timeoutMs = 30_000): Promise<SandboxSnapshot> {
    const body = await this.request<{ sandbox: SandboxSnapshot }>(
      "GET",
      `/sandboxes/${encodeURIComponent(id)}/ready?timeoutMs=${timeoutMs}`,
    );
    return body.sandbox;
  }

  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: payload === undefined ? undefined : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    } catch (error) {
      throw new SandboxError("unavailable", `cannot reach the sandbox control plane at ${this.baseUrl}: ${String(error)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const detail = (body.error ?? {}) as { code?: string; message?: string };
      throw new SandboxError(
        (detail.code ?? "unavailable") as "not_found" | "conflict" | "invalid" | "unsupported" | "unavailable" | "timeout",
        detail.message ?? `control plane returned ${response.status}`,
      );
    }
    return body as T;
  }
}

export interface ExecEvent {
  type: "stdout" | "stderr" | "exit";
  chunk?: string;
  code?: number;
  raw?: Record<string, unknown>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ExecdClient {
  readonly url: string;
  readonly token: string;

  constructor(endpoint: Endpoint) {
    this.url = endpoint.url.replace(/\/+$/, "");
    this.token = endpoint.headers?.["X-EXECD-ACCESS-TOKEN"] ?? process.env.EXECD_ACCESS_TOKEN ?? "";
  }

  async ping(): Promise<{ ok: boolean; pid: number; root: string }> {
    return this.json("GET", "/ping");
  }

  async run(
    command: string,
    options: { cwd?: string; timeoutMs?: number; onEvent?: (event: ExecEvent) => void } = {},
  ): Promise<CommandResult> {
    const response = await fetch(`${this.url}/command`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ command, cwd: options.cwd, timeoutMs: options.timeoutMs }),
    });
    if (!response.ok || !response.body) {
      throw new SandboxError("unavailable", `execd /command failed: ${response.status} ${await response.text()}`);
    }

    const result: CommandResult = { exitCode: -1, stdout: "", stderr: "" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) {
          options.onEvent?.(event);
          if (event.type === "stdout") result.stdout += event.chunk ?? "";
          if (event.type === "stderr") result.stderr += event.chunk ?? "";
          if (event.type === "exit") {
            result.exitCode = event.code ?? -1;
            await reader.cancel();
            return result;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return result;
  }

  async readFile(path: string, encoding: "utf-8" | "base64" = "utf-8"): Promise<{ content: string; size: number }> {
    const query = new URLSearchParams({ path, encoding: encoding === "base64" ? "base64" : "utf-8" });
    return this.json("GET", `/file?${query.toString()}`);
  }

  async writeFile(path: string, content: string, encoding: "utf-8" | "base64" = "utf-8"): Promise<{ path: string; bytes: number }> {
    return this.json("PUT", "/file", { path, content, encoding: encoding === "base64" ? "base64" : "utf-8" });
  }

  async listDirectory(path: string): Promise<{ entries: Array<{ name: string; type: string; size: number }> }> {
    return this.json("GET", `/directory?${new URLSearchParams({ path }).toString()}`);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, "X-EXECD-ACCESS-TOKEN": this.token };
  }

  private async json<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(payload === undefined ? undefined : { "content-type": "application/json" }),
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const detail = (body.error ?? {}) as { code?: string; message?: string };
      throw new SandboxError("unavailable", `execd ${path}: ${detail.message ?? response.status}`);
    }
    return body as T;
  }
}

function parseFrame(frame: string): ExecEvent | undefined {
  let event = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (!event || data.length === 0) return undefined;
  try {
    const payload = JSON.parse(data.join("\n")) as { chunk?: string; code?: number };
    if (event === "exit") return { type: "exit", code: payload.code, raw: payload };
    if (event === "stdout" || event === "stderr") return { type: event, chunk: payload.chunk, raw: payload };
  } catch {
    return undefined;
  }
  return undefined;
}
