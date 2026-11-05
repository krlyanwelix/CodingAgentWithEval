/**
 * The control plane's own bookkeeping.
 *
 * This is deliberately disposable: the runtime holds the real state. A record
 * only adds what the backend cannot tell us cheaply — the absolute deadline and
 * the execd token. Both are also written onto the workload as labels/env, so a
 * lost file can be rebuilt from `SandboxService.list()`/`get()`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SandboxRecord {
  id: string;
  image: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. Absolute; pause/resume never moves this. */
  expiresAt: number;
  execdPort: number;
  token: string;
  labels: Record<string, string>;
}

export interface MetadataStore {
  get(id: string): SandboxRecord | undefined;
  put(record: SandboxRecord): void;
  delete(id: string): void;
  list(): SandboxRecord[];
}

export class MemoryMetadataStore implements MetadataStore {
  protected readonly records = new Map<string, SandboxRecord>();

  get(id: string): SandboxRecord | undefined {
    return this.records.get(id);
  }

  put(record: SandboxRecord): void {
    this.records.set(record.id, record);
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  list(): SandboxRecord[] {
    return [...this.records.values()];
  }
}

/** JSON-file store. Losing or truncating the file must stay safe by design. */
export class FileMetadataStore extends MemoryMetadataStore {
  constructor(private readonly file: string) {
    super();
    this.load();
  }

  override put(record: SandboxRecord): void {
    super.put(record);
    this.persist();
  }

  override delete(id: string): void {
    super.delete(id);
    this.persist();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sandboxes?: SandboxRecord[] };
      for (const record of raw.sandboxes ?? []) this.records.set(record.id, record);
    } catch {
      // Missing or corrupt metadata is expected to be recoverable, not fatal.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ sandboxes: this.list() }, null, 2)}\n`, "utf8");
  }
}
