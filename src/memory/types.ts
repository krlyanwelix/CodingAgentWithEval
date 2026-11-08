/**
 * The memory port: everything the agent is allowed to assume about long-term
 * memory. Implementations talk HTTP, files, or nothing at all, but the agent
 * only ever sees this interface — which keeps the memory backend replaceable
 * and keeps the agent loop free of vendor-specific types.
 */

export type MemoryKind = "fact" | "preference" | "decision" | "note";

export interface MemoryHit {
  id: string;
  text: string;
  /** Relevance in [0, 1]; the service already applied the score threshold. */
  score: number;
  createdAt?: string;
  kind?: MemoryKind;
  projectId?: string;
}

export interface RecallOptions {
  limit?: number;
  minScore?: number;
  /** Hard cap on the characters returned, so recall can never blow the prompt. */
  budgetChars?: number;
}

export interface RememberInput {
  /** Exact text to store. Required unless `messages` is given. */
  text?: string;
  /** Conversation slice handed to the extractor; ignored when `text` is set. */
  messages?: Array<{ role: string; content: string }>;
  sessionId?: string;
  kind?: MemoryKind;
  /**
   * true (default): let the service extract durable facts.
   * false: store the text verbatim — deterministic, used by explicit `/remember`.
   */
  infer?: boolean;
  /** 0 or undefined keeps the memory forever. */
  ttlDays?: number;
}

export interface RememberResult {
  written: number;
  skipped: string[];
}

export interface MemoryHealth {
  ok: boolean;
  error?: string;
}

export interface MemoryPort {
  /** False once startup failed; the agent then runs without long-term memory. */
  readonly enabled: boolean;
  /** Start the service (spawn or connect) and report whether it answers. */
  start(): Promise<boolean>;
  /** Cheap re-check, used after a boot-time failure; implementations back off. */
  refresh(): Promise<boolean>;
  health(): Promise<MemoryHealth>;
  recall(query: string, options?: RecallOptions): Promise<MemoryHit[]>;
  remember(input: RememberInput): Promise<RememberResult>;
  list(limit?: number): Promise<MemoryHit[]>;
  forget(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
