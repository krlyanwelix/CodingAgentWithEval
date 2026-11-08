import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Agent } from "./agent.js";
import { createModel, describeModel } from "./model-config.js";
import { tools as builtinTools } from "./tools.js";
import { SessionStore } from "./session-store.js";
import { createSkillLoaderTool, discoverSkills, loadExternalTools } from "./loader.js";
import { memoryFromEnv, recallMemoryBlock, summarizeTurn } from "./memory/index.js";
import type { Message } from "./types.js";
import { buildSystemPrompt } from "./prompt.js";
import { policyFromEnv, verificationFromEnv } from "./harness/config.js";
import { traceFromEnv } from "./harness/trace.js";

const projectRoot = resolve(process.cwd());
const webRoot = join(projectRoot, "web");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const { model, settings: modelSettings } = (() => {
  try {
    return createModel();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
})();
console.log(`Using ${describeModel(modelSettings)}`);

const contextLimit = (() => {
  const value = Number.parseInt(process.env.CONTEXT_MAX_INPUT_TOKENS ?? "24000", 10);
  return Number.isFinite(value) && value > 0 ? value : 24000;
})();
const externalTools = await loadExternalTools(process.env.AGENT_TOOLS_DIR ?? "tools");
const skills = await discoverSkills(process.env.AGENT_SKILLS_DIR ?? "skills");
const loadedTools = [...builtinTools, ...externalTools, ...(skills.length ? [createSkillLoaderTool(skills)] : [])];
const sessionStore = new SessionStore(process.env.SESSION_DB ?? "data/agent.sqlite");
const memory = memoryFromEnv();
const memoryBudgetChars = Number.parseInt(process.env.MEMORY_BUDGET_CHARS ?? "900", 10) || 900;
// Never block `listen` on the memory service: Mem0's cold start can take seconds,
// and every call site below already degrades to an empty result.
let memoryAvailable = false;
void (async () => {
  memoryAvailable = await memory.start();
  if (!memoryAvailable) {
    const health = await memory.health();
    console.warn(`Long-term memory is off: ${health.error ?? "memory service unavailable"}. Log: data/memory-service.log`);
  }
})();

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(body);
}

function sse(res: ServerResponse, event: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 1_000_000) throw new Error("Request body is too large");
  }
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function systemPrompt(): string {
  return buildSystemPrompt(modelSettings.model, skills);
}

function createAgent(history: Message[], allowTools: boolean): Agent {
  return new Agent({
    model,
    tools: loadedTools,
    history,
    context: { maxInputTokens: contextLimit },
    systemPrompt: systemPrompt(),
    modelTimeoutMs: modelSettings.timeoutMs,
    streamIdleTimeoutMs: modelSettings.streamIdleTimeoutMs,
    // The web UI has no terminal prompt, so the browser decides per request whether
    // commands may run (the composer toggle) and the server can force-deny with WEB_ALLOW_TOOLS=0.
    confirmToolCall: async () => allowTools,
    // In the browser there is nobody to answer a second prompt: the per-request
    // toggle already grants shell, so auto-approve the policy's "ask" decisions.
    policy: { ...policyFromEnv(), autoApproveRisk: allowTools ? "high" : "never" },
    verification: verificationFromEnv(),
    trace: traceFromEnv(),
  });
}

function latestNodeId(sessionId: string, requested?: string): string | null {
  if (requested) {
    if (!sessionStore.listNodes(sessionId).some((node) => node.id === requested)) throw new Error("Node does not belong to this session");
    sessionStore.getPath(requested);
    return requested;
  }
  const nodes = sessionStore.listNodes(sessionId);
  return nodes.length ? nodes[nodes.length - 1].id : null;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = await body(req);
  const sessionId = text(input.sessionId, "sessionId");
  const prompt = text(input.input, "input");
  const parentId = latestNodeId(sessionId, typeof input.nodeId === "string" ? input.nodeId : undefined);
  const history = parentId ? sessionStore.getPath(parentId) : [];
  const currentNodeId = sessionStore.createTurn(sessionId, parentId, prompt);
  // The service may come up after the server booted; refresh is cheap and backs off.
  if (!memoryAvailable) memoryAvailable = await memory.refresh();
  const memoryContext = memoryAvailable
    ? await recallMemoryBlock(memory, prompt, memoryBudgetChars)
    : undefined;
  const agent = createAgent(history, input.allowTools !== false && process.env.WEB_ALLOW_TOOLS !== "0");
  const turnMessages: Array<{ role: string; content: string }> = [{ role: "user", content: prompt }];
  const toolNames: string[] = [];
  const toolResults: Array<{ name: string; output: string }> = [];
  let assistantContent: string | null = null;

  // Closing the tab or pressing Stop aborts the HTTP request; forward that to the agent
  // so the in-flight model call and tool processes stop instead of running to the end.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  sse(res, { type: "start", sessionId, nodeId: currentNodeId });
  try {
    for await (const event of agent.run(prompt, { context: memoryContext, signal: controller.signal })) {
      if (event.type === "message_end") {
        if (event.message.content !== null) assistantContent = event.message.content;
      } else if (event.type === "tool_end") {
        toolNames.push(event.toolCall.function.name);
        // Keep a bounded copy so a reloaded session can still show what the tool said.
        toolResults.push({ name: event.toolCall.function.name, output: String(event.result ?? "").slice(0, 2000) });
      } else if (event.type === "aborted") {
        assistantContent = event.partial ? `${event.partial}\n\n[Stopped by user]` : "[Stopped by user]";
      }
      sse(res, event.type === "error" ? { type: "error", message: event.error.message } : event);
    }
    sessionStore.completeTurn(currentNodeId, assistantContent, toolNames, toolResults);
    if (assistantContent) turnMessages.push({ role: "assistant", content: assistantContent });
    // Extraction costs a model call plus embeddings; do not hold the response open for it.
    if (memoryAvailable && summarizeTurn(turnMessages)) {
      void memory.remember({ messages: turnMessages, sessionId, kind: "fact" });
    }
    sse(res, { type: "done", sessionId, nodeId: currentNodeId, usage: agent.getUsage() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionStore.completeTurn(currentNodeId, assistantContent ?? `Error: ${message}`, toolNames, toolResults);
    sse(res, { type: "error", message });
  } finally {
    res.end();
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type" });
    res.end();
    return true;
  }
  if (path === "/api/health" && req.method === "GET") {
    if (!memoryAvailable) memoryAvailable = await memory.refresh();
    const memoryError = memoryAvailable ? undefined : (await memory.health()).error;
    json(res, 200, {
      ok: true,
      model: modelSettings.model,
      contextLimit,
      memoryAvailable,
      memoryError,
      workspace: projectRoot,
    });
    return true;
  }
  if (path === "/api/sessions" && req.method === "GET") {
    json(res, 200, { sessions: sessionStore.listSessions() });
    return true;
  }
  if (path === "/api/sessions" && req.method === "POST") {
    const input = await body(req);
    const displayName = typeof input.name === "string" ? input.name.trim() : "";
    if (displayName.length > 120) throw new Error("Session name must be 120 characters or fewer");
    const sessionId = sessionStore.createSession(displayName || undefined);
    json(res, 201, { sessionId });
    return true;
  }
  const deleteSessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (deleteSessionMatch && req.method === "DELETE") {
    if (!sessionStore.deleteSession(deleteSessionMatch[1])) {
      json(res, 404, { error: "Session not found" });
      return true;
    }
    res.writeHead(204, { "access-control-allow-origin": "*" });
    res.end();
    return true;
  }
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)\/nodes$/);
  if (sessionMatch && req.method === "GET") {
    json(res, 200, { nodes: sessionStore.listNodes(sessionMatch[1]) });
    return true;
  }
  const forkMatch = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
  if (forkMatch && req.method === "POST") {
    const input = await body(req);
    const nodeId = text(input.nodeId, "nodeId");
    if (!sessionStore.listNodes(forkMatch[1]).some((node) => node.id === nodeId)) throw new Error("Node does not belong to this session");
    const fork = sessionStore.forkFromNode(nodeId);
    json(res, 201, fork);
    return true;
  }
  if (path === "/api/chat" && req.method === "POST") {
    await handleChat(req, res);
    return true;
  }
  if (path === "/api/search" && req.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < 2) {
      json(res, 200, { query, sessions: [], messages: [], memories: [] });
      return true;
    }
    const sessions = sessionStore.listSessions();
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const lowered = query.toLowerCase();
    const sessionHits = sessions
      .filter((session) => (session.displayName ?? "").toLowerCase().includes(lowered))
      .slice(0, 5)
      .map((session) => ({ id: session.id, name: session.displayName ?? "Session", updatedAt: session.updatedAt, turns: session.nodeCount }));
    const messageHits = sessionStore.searchTurns(query, 12).map((hit) => ({
      ...hit,
      sessionName: byId.get(hit.sessionId)?.displayName ?? "Session",
    }));
    const memoryHits = memoryAvailable
      ? (await memory.recall(query, { limit: 4 })).map((hit) => ({ id: hit.id, text: hit.text, score: hit.score }))
      : [];
    json(res, 200, { query, sessions: sessionHits, messages: messageHits, memories: memoryHits });
    return true;
  }
  if (path === "/api/memories" && req.method === "GET") {
    json(res, 200, { memories: memoryAvailable ? await memory.list() : [] });
    return true;
  }
  if (path === "/api/memories/search" && req.method === "POST") {
    const input = await body(req);
    json(res, 200, {
      memories: memoryAvailable ? await memory.recall(text(input.query, "query"), { limit: 10 }) : [],
    });
    return true;
  }
  const memoryMatch = path.match(/^\/api\/memories\/([^/]+)$/);
  if (memoryMatch && req.method === "DELETE") {
    if (memoryAvailable) await memory.forget(memoryMatch[1]);
    json(res, 204, null);
    return true;
  }
  if (path === "/api/memories" && req.method === "DELETE") {
    if (memoryAvailable) await memory.clear();
    json(res, 204, null);
    return true;
  }
  return false;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const file = resolve(webRoot, `.${normalize(requested)}`);
  if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) { json(res, 403, { error: "Forbidden" }); return; }
  try {
    const data = await readFile(file);
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      if (await handleApi(req, res, url)) return;
      json(res, 404, { error: "Not found" });
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    else res.end();
  }
});

server.listen(port, host, () => console.log(`CodingAgentWithEval web UI: http://${host}:${port}`));
process.on("SIGINT", () => { sessionStore.close(); memory.close(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { sessionStore.close(); memory.close(); server.close(() => process.exit(0)); });
