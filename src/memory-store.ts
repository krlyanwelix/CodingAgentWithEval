import * as lancedb from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { EmbeddingClient } from "./embedding.js";

export type MemoryCategory = "preference" | "profile" | "fact" | "project" | "decision";
export interface MemoryRecord {
  id: string;
  content: string;
  category: MemoryCategory;
  userId: string;
  sourceSessionId: string;
  importance: number;
  createdAt: string;
  vector: number[];
}

const TABLE_NAME = "memories";
const CATEGORIES = new Set<MemoryCategory>(["preference", "profile", "fact", "project", "decision"]);

export class MemoryStore {
  private table?: Table;
  private readonly userId: string;

  private constructor(private readonly db: lancedb.Connection, private readonly embeddings: EmbeddingClient, userId: string) {
    this.userId = userId;
  }

  static async open(options: { uri: string; embeddings: EmbeddingClient; userId?: string }): Promise<MemoryStore> {
    mkdirSync(dirname(resolve(options.uri)), { recursive: true });
    const db = await lancedb.connect(options.uri);
    const store = new MemoryStore(db, options.embeddings, options.userId ?? "local-user");
    if ((await db.tableNames()).includes(TABLE_NAME)) store.table = await db.openTable(TABLE_NAME);
    return store;
  }

  async add(input: { content: string; category: string; sourceSessionId: string; importance?: number }): Promise<string> {
    const content = input.content.trim();
    if (!content) throw new Error("Memory content cannot be empty");
    if (content.length > 4000) throw new Error("Memory content must be 4000 characters or fewer");
    if (/(api[_ -]?key|secret|password|passwd|token)\s*[:=]\s*\S+/i.test(content)) {
      throw new Error("Memory appears to contain a secret; it was not saved");
    }
    const category = this.category(input.category);
    const importance = Math.max(0, Math.min(1, input.importance ?? 0.7));
    if (!this.table) {
      const id = randomUUID();
      const vector = await this.embeddings.embed(content);
      const row: MemoryRecord = { id, content, category, userId: this.userId, sourceSessionId: input.sourceSessionId, importance, createdAt: new Date().toISOString(), vector };
      this.table = await this.db.createTable(TABLE_NAME, [{ ...row }]);
      return id;
    }
    const id = randomUUID();
    const row: MemoryRecord = {
      id,
      content,
      category,
      userId: this.userId,
      sourceSessionId: input.sourceSessionId,
      importance,
      createdAt: new Date().toISOString(),
      vector: await this.embeddings.embed(content),
    };
    await this.table.add([{ ...row }]);
    return id;
  }

  async search(query: string, limit = 5): Promise<Array<MemoryRecord & { _distance?: number }>> {
    if (!this.table) return [];
    const vector = await this.embeddings.embed(query);
    const rows = await this.table.vectorSearch(vector).where(`userId = '${this.userId.replaceAll("'", "''")}'`).limit(limit).toArray() as Array<MemoryRecord & { _distance?: number }>;
    return rows;
  }

  async list(): Promise<MemoryRecord[]> {
    if (!this.table) return [];
    return await this.table.query().where(`userId = '${this.userId.replaceAll("'", "''")}'`).limit(10_000).toArray() as MemoryRecord[];
  }

  async delete(id: string): Promise<boolean> {
    if (!this.table) return false;
    const found = (await this.table.query().where(`id = '${id.replaceAll("'", "''")}' AND userId = '${this.userId.replaceAll("'", "''")}'`).limit(1).toArray()).length > 0;
    if (found) await this.table.delete(`id = '${id.replaceAll("'", "''")}' AND userId = '${this.userId.replaceAll("'", "''")}'`);
    return found;
  }

  async clear(): Promise<number> {
    if (!this.table) return 0;
    const count = await this.table.countRows(`userId = '${this.userId.replaceAll("'", "''")}'`);
    if (count > 0) await this.table.delete(`userId = '${this.userId.replaceAll("'", "''")}'`);
    return count;
  }

  close(): void { this.db.close(); }

  private category(value: string): MemoryCategory {
    if (!CATEGORIES.has(value as MemoryCategory)) throw new Error(`Invalid category. Use: ${[...CATEGORIES].join(", ")}`);
    return value as MemoryCategory;
  }
}
