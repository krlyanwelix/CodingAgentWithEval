import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "./types.js";

export interface SessionSummary { id: string; displayName: string | null; createdAt: string; updatedAt: string; nodeCount: number; }
export interface NodeSummary { id: string; parentId: string | null; role: Message["role"]; content: string | null; createdAt: string; }

/** SQLite persistence boundary. Each message is a node and parent_id forms the conversation tree. */
export class SessionStore {
  private readonly db: Database.Database;

  constructor(filename = resolve(process.cwd(), "data", "agent.sqlite")) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, display_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nodes(id), role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id, created_at);`);
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "display_name")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN display_name TEXT");
    }
  }

  createSession(displayName?: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const name = displayName?.trim().slice(0, 120) || null;
    this.db.prepare("INSERT INTO sessions (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
    return id;
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare("SELECT s.id, s.display_name, s.created_at, s.updated_at, COUNT(n.id) AS node_count FROM sessions s LEFT JOIN nodes n ON n.session_id = s.id GROUP BY s.id ORDER BY s.updated_at DESC").all() as Array<{ id: string; display_name: string | null; created_at: string; updated_at: string; node_count: number }>;
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, createdAt: r.created_at, updatedAt: r.updated_at, nodeCount: r.node_count }));
  }

  listNodes(sessionId: string): NodeSummary[] {
    const rows = this.db.prepare("SELECT id, parent_id, role, content, created_at FROM nodes WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as Array<{ id: string; parent_id: string | null; role: Message["role"]; content: string | null; created_at: string }>;
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, role: r.role, content: r.content, createdAt: r.created_at }));
  }

  getPath(nodeId: string): Message[] {
    const rows: Array<{ parent_id: string | null; role: Message["role"]; content: string | null; tool_call_id: string | null; tool_calls: string | null }> = [];
    let current: string | null = nodeId;
    while (current) {
      const row = this.db.prepare("SELECT parent_id, role, content, tool_call_id, tool_calls FROM nodes WHERE id = ?").get(current) as ({ parent_id: string | null; role: Message["role"]; content: string | null; tool_call_id: string | null; tool_calls: string | null } | undefined);
      if (!row) throw new Error(`Node not found: ${current}`);
      rows.push(row);
      current = row.parent_id;
    }
    return rows.reverse().map((row) => ({ role: row.role, content: row.content, ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}), ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}) }));
  }

  appendNode(sessionId: string, parentId: string | null, message: Message): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO nodes (id, session_id, parent_id, role, content, tool_call_id, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, sessionId, parentId, message.role, message.content, message.tool_call_id ?? null, message.tool_calls ? JSON.stringify(message.tool_calls) : null, now);
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    return id;
  }

  forkFromNode(nodeId: string): { sessionId: string; nodeId: string } {
    const sessionId = this.createSession("Forked session");
    let parent: string | null = null;
    for (const message of this.getPath(nodeId)) parent = this.appendNode(sessionId, parent, message);
    return { sessionId, nodeId: parent as string };
  }

  close(): void { this.db.close(); }
}
