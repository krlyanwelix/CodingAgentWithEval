import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "./types.js";

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Persistence boundary for conversations. Agent itself knows nothing about SQLite. */
export class SessionStore {
  private readonly db: Database.Database;

  constructor(filename = resolve(process.cwd(), "data", "agent.sqlite")) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
    `);
  }

  createSession(id: string = randomUUID()): string {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)").run(id, now, now);
    return id;
  }

  ensureSession(id: string): string {
    const found = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
    return found ? id : this.createSession(id);
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT s.id, s.created_at, s.updated_at, COUNT(m.id) AS message_count
      FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY s.id ORDER BY s.updated_at DESC
    `).all() as Array<{ id: string; created_at: string; updated_at: string; message_count: number }>;
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, messageCount: row.message_count }));
  }

  appendMessage(sessionId: string, message: Message): void {
    this.ensureSession(sessionId);
    this.db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, message.role, message.content, message.tool_call_id ?? null, message.tool_calls ? JSON.stringify(message.tool_calls) : null, new Date().toISOString());
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db.prepare("SELECT role, content, tool_call_id, tool_calls FROM messages WHERE session_id = ? ORDER BY id").all(sessionId) as Array<{
      role: Message["role"];
      content: string | null;
      tool_call_id: string | null;
      tool_calls: string | null;
    }>;
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
      ...(row.tool_calls ? { tool_calls: JSON.parse(row.tool_calls) } : {}),
    }));
  }

  close(): void {
    this.db.close();
  }
}
