/**
 * Control-plane HTTP API.
 *
 * The control plane never talks to Docker. It validates requests, calls the
 * `LifecycleService`, and turns its errors into status codes. Execution does
 * not go through here: clients use `GET /sandboxes/{id}/endpoints/{port}` and
 * talk to the data plane inside the sandbox.
 *
 * Routes:
 *   POST   /sandboxes
 *   GET    /sandboxes
 *   GET    /sandboxes/{id}
 *   DELETE /sandboxes/{id}
 *   POST   /sandboxes/{id}/pause
 *   POST   /sandboxes/{id}/resume
 *   GET    /sandboxes/{id}/endpoints/{port}
 *   GET    /sandboxes/{id}/ready?timeoutMs=30000
 *   GET    /healthz
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SandboxError, type SandboxErrorCode, type SandboxSpec } from "./types.js";
import { LifecycleService } from "./service.js";

const MAX_BODY_BYTES = 1024 * 1024;

const ERROR_STATUS: Record<SandboxErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
  unsupported: 501,
  unavailable: 503,
  timeout: 504,
};

interface RequestContext {
  service: LifecycleService;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}

export function createControlPlane(service: LifecycleService): Server {
  return createServer((req, res) => {
    void dispatch(service, req, res).catch((error: unknown) => {
      sendError(res, error);
    });
  });
}

async function dispatch(service: LifecycleService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://control-plane.local");
  const segments = url.pathname.split("/").filter(Boolean);
  const ctx: RequestContext = { service, req, res, url };

  if (req.method === "GET" && segments.length === 1 && segments[0] === "healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (segments.length === 0 || segments[0] !== "sandboxes") {
    throw new SandboxError("not_found", `no route for ${req.method} ${url.pathname}`);
  }

  if (segments.length === 1) {
    if (req.method === "POST") {
      const spec = await readJsonBody<SandboxSpec>(req);
      const sandbox = await service.create(spec ?? {});
      return sendJson(res, 202, { sandbox });
    }
    if (req.method === "GET") {
      return sendJson(res, 200, { sandboxes: await service.list() });
    }
    throw new SandboxError("not_found", `no route for ${req.method} ${url.pathname}`);
  }

  const id = decodeURIComponent(segments[1]);
  if (segments.length === 2) {
    if (req.method === "GET") {
      const sandbox = await service.get(id);
      if (!sandbox) throw new SandboxError("not_found", `sandbox ${id} does not exist`);
      return sendJson(res, 200, { sandbox });
    }
    if (req.method === "DELETE") {
      await service.delete(id);
      return sendEmpty(res, 204);
    }
    throw new SandboxError("not_found", `no route for ${req.method} ${url.pathname}`);
  }

  const action = segments[2];
  if (segments.length === 3 && req.method === "POST" && (action === "pause" || action === "resume")) {
    const sandbox = action === "pause" ? await service.pause(id) : await service.resume(id);
    return sendJson(res, 200, { sandbox });
  }
  if (segments.length === 3 && action === "ready" && req.method === "GET") {
    const timeoutMs = Math.min(Number(ctx.url.searchParams.get("timeoutMs") ?? 30_000) || 30_000, 120_000);
    return sendJson(res, 200, { sandbox: await service.waitReady(id, timeoutMs) });
  }
  if (segments.length === 4 && action === "endpoints" && req.method === "GET") {
    const port = Number(segments[3]);
    if (!Number.isInteger(port) || port <= 0) throw new SandboxError("invalid", `invalid port: ${segments[3]}`);
    return sendJson(res, 200, { endpoint: await service.getEndpoint(id, port) });
  }

  throw new SandboxError("not_found", `no route for ${req.method} ${url.pathname}`);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new SandboxError("invalid", "request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new SandboxError("invalid", "request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-length": "0" });
  res.end();
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof SandboxError) {
    sendJson(res, ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: { code: "internal", message } });
}
