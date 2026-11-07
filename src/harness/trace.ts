import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * Structured run traces.
 *
 * Every model call, tool call and decision lands in one JSONL file per run, with
 * timestamps and estimated token counts. The trace is the evidence base for the
 * evaluator's "first error attribution": when a run fails you can see whether the
 * model wrote a bad patch or the harness fed it a truncated file.
 */

export interface TraceRecord {
  ts: string;
  runId: string;
  type: string;
  [key: string]: unknown;
}

export class TraceRecorder {
  readonly runId: string;
  private readonly filePath?: string;
  private closed = false;

  constructor(filePath?: string, runId = randomUUID().slice(0, 8)) {
    this.runId = runId;
    this.filePath = filePath ? resolve(filePath) : undefined;
    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch {
        this.closed = true;
      }
    }
  }

  get path(): string | undefined {
    return this.filePath;
  }

  record(type: string, data: Record<string, unknown> = {}): void {
    if (!this.filePath || this.closed) return;
    const record: TraceRecord = { ts: new Date().toISOString(), runId: this.runId, type, ...data };
    try {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Tracing is observability, never a reason to fail a run.
      this.closed = true;
    }
  }

  close(): void {
    this.closed = true;
  }
}

/** `TRACE_DIR=/tmp/agent` makes the CLI write traces; unset means no tracing. */
export function traceFromEnv(env: NodeJS.ProcessEnv = process.env): TraceRecorder {
  const dir = env.TRACE_DIR?.trim();
  if (!dir || env.TRACE_ENABLED === "0") return new TraceRecorder(undefined);
  return new TraceRecorder(`${dir.replace(/[\\/]+$/, "")}/run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
}
