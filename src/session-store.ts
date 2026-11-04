import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "./types.js";

export interface SessionSummary {
  id: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

export interface TurnNodeSummary {
  id: string;
  parentId: string | null;
  userContent: string;
  assistantContent: string | null;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  user_content: string;
  assistant_content: string | null;
  tool_names: string;
  created_at: string;
  updated_at: string;
}

function parseToolNames(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** SQLite persistence boundary. Each tree node is one complete user/assistant turn. */
export class SessionStore {
  private readonly db: Database.Database;

  constructor(filename = resolve(process.cwd(), "data", "agent.sqlite")) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES turns(id),
        user_content TEXT NOT NULL,
        assistant_content TEXT,
        tool_names TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_id);
    `);
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

  deleteSession(sessionId: string): boolean {
    const transaction = this.db.transaction((id: string) => {
      const exists = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
      if (!exists) return false;
      // Detach the self-referencing turn tree first. This keeps deletion
      // compatible with databases created before parent_id used CASCADE.
      this.db.prepare("UPDATE turns SET parent_id = NULL WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      return true;
    });
    return transaction(sessionId);
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT s.id, s.display_name, s.created_at, s.updated_at, COUNT(t.id) AS node_count
      FROM sessions s
      LEFT JOIN turns t ON t.session_id = s.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
    `).all() as Array<{ id: string; display_name: string | null; created_at: string; updated_at: string; node_count: number }>;
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodeCount: row.node_count,
    }));
  }

  listNodes(sessionId: string): TurnNodeSummary[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, parent_id, user_content, assistant_content, tool_names, created_at, updated_at
      FROM turns
      WHERE session_id = ?
      ORDER BY created_at, rowid
    `).all(sessionId) as TurnRow[];
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      userContent: row.user_content,
      assistantContent: row.assistant_content,
      toolNames: parseToolNames(row.tool_names),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getPath(nodeId: string): Message[] {
    const turns = this.getTurnPath(nodeId);
    const messages: Message[] = [];
    for (const turn of turns) {
      messages.push({ role: "user", content: turn.user_content });
      if (turn.assistant_content !== null) messages.push({ role: "assistant", content: turn.assistant_content });
    }
    return messages;
  }

  createTurn(sessionId: string, parentId: string | null, userContent: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO turns (id, session_id, parent_id, user_content, assistant_content, tool_names, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, '[]', ?, ?)
    `).run(id, sessionId, parentId, userContent, now, now);
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    return id;
  }

  completeTurn(nodeId: string, assistantContent: string | null, toolNames: string[]): void {
    const now = new Date().toISOString();
    const uniqueToolNames = [...new Set(toolNames.filter(Boolean))];
    const result = this.db.prepare(`
      UPDATE turns
      SET assistant_content = ?, tool_names = ?, updated_at = ?
      WHERE id = ?
    `).run(assistantContent, JSON.stringify(uniqueToolNames), now, nodeId);
    if (result.changes !== 1) throw new Error(`Turn not found: ${nodeId}`);
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = (SELECT session_id FROM turns WHERE id = ?)").run(now, nodeId);
  }

  closePendingTurns(sessionId: string): number {
    // A turn with no assistant content means the process died mid-turn. Marking
    // it keeps a resumed history from ending on a dangling user message.
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE turns
      SET assistant_content = ?, updated_at = ?
      WHERE session_id = ? AND assistant_content IS NULL
    `).run("（这一回合在完成前被中断）", now, sessionId);
    return result.changes;
  }

  forkFromNode(nodeId: string): { sessionId: string; nodeId: string } {
    const sourceTurns = this.getTurnPath(nodeId);
    const sessionId = this.createSession("Forked session");
    let parentId: string | null = null;
    for (const turn of sourceTurns) {
      const copiedId = this.createTurn(sessionId, parentId, turn.user_content);
      this.completeTurn(copiedId, turn.assistant_content, parseToolNames(turn.tool_names));
      parentId = copiedId;
    }
    if (!parentId) throw new Error(`Turn not found: ${nodeId}`);
    return { sessionId, nodeId: parentId };
  }

  close(): void {
    this.db.close();
  }

  private getTurnPath(nodeId: string): TurnRow[] {
    const rows: TurnRow[] = [];
    const seen = new Set<string>();
    let currentId: string | null = nodeId;
    while (currentId) {
      if (seen.has(currentId)) throw new Error(`Cycle detected at turn: ${currentId}`);
      seen.add(currentId);
      const row = this.db.prepare(`
        SELECT id, session_id, parent_id, user_content, assistant_content, tool_names, created_at, updated_at
        FROM turns
        WHERE id = ?
      `).get(currentId) as TurnRow | undefined;
      if (!row) throw new Error(`Turn not found: ${currentId}`);
      rows.push(row);
      currentId = row.parent_id;
    }
    return rows.reverse();
  }
}
