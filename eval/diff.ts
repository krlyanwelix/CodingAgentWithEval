import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Workspace diffing for the evaluator.
 *
 * The judge must see what actually changed, not the whole workspace: a diff is
 * small enough to fit in a judge prompt and it is the one artifact that cannot
 * be faked by confident prose. The seed files are already in memory, so the
 * "before" side costs nothing and no git repository is required.
 */

const IGNORED = new Set(["node_modules", ".git", "dist", "build", "coverage", ".cache", "data"]);

export interface WorkspaceDiff {
  changed: string[];
  /** Unified-style diff, truncated to keep judge prompts bounded. */
  diff: string;
}

export function computeDiff(seed: Record<string, string>, directory: string, limit = 8000): WorkspaceDiff {
  const changed: string[] = [];
  const blocks: string[] = [];
  let budget = limit;

  for (const file of walk(directory)) {
    if (budget <= 0) break;
    const absolute = join(directory, ...file.split("/"));
    let text: string;
    try {
      if (statSync(absolute).size > 512 * 1024) continue;
      const buffer = readFileSync(absolute);
      if (buffer.subarray(0, 4096).includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }
    const before = seed[file];
    if (before === text) continue;
    changed.push(file);
    const block = lineDiff(file, before ?? "", text);
    if (!block) continue;
    const clipped = block.length > budget ? `${block.slice(0, budget)}\n... [diff truncated]` : block;
    blocks.push(clipped);
    budget -= clipped.length;
  }

  return { changed, diff: blocks.join("\n") };
}

function walk(root: string, depth = 0): string[] {
  if (depth > 10) return [];
  const files: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.endsWith(".lock")) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(absolute, depth + 1));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files;
}

const MAX_LINES = 700;

/**
 * Minimal line diff: LCS over lines, then hunks with two lines of context.
 * Large files degrade to "first changed lines" rather than quadratic memory.
 */
export function lineDiff(path: string, before: string, after: string): string {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const header = `--- a/${path}\n+++ b/${path}\n`;

  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    const firstOld = oldLines.findIndex((line, index) => line !== newLines[index]);
    return `${header}@@ large file, diff omitted (${oldLines.length} -> ${newLines.length} lines), first change near line ${firstOld + 1} @@`;
  }

  const ops = lcsOps(oldLines, newLines);
  const hunks = toHunks(ops, 2);
  return hunks.length === 0 ? "" : `${header}${hunks.join("\n")}`;
}

type Op = { kind: " " | "-" | "+"; line: string; oldLine: number; newLine: number };

function lcsOps(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length;
  const m = newLines.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = oldLines[i] === newLines[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: " ", line: oldLines[i]!, oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "-", line: oldLines[i]!, oldLine: i + 1, newLine: j + 1 });
      i += 1;
    } else {
      ops.push({ kind: "+", line: newLines[j]!, oldLine: i + 1, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "-", line: oldLines[i]!, oldLine: i + 1, newLine: j + 1 }), (i += 1);
  while (j < m) ops.push({ kind: "+", line: newLines[j]!, oldLine: i + 1, newLine: j + 1 }), (j += 1);
  return ops;
}

function toHunks(ops: Op[], context: number): string[] {
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  return ranges.map(([start, end]) => {
    const slice = ops.slice(start, end);
    const oldStart = slice.find((op) => op.kind !== "+")?.oldLine ?? slice[0]!.oldLine;
    const newStart = slice.find((op) => op.kind !== "-")?.newLine ?? slice[0]!.newLine;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const body = slice.map((op) => `${op.kind}${op.line}`).join("\n");
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
  });
}

/** True when the workspace no longer matches the seed (used by the runner to skip diffing). */
export function workspaceMatchesSeed(seed: Record<string, string>, directory: string): boolean {
  if (!existsSync(directory)) return false;
  return Object.entries(seed).every(([file, content]) => {
    try {
      return readFileSync(join(directory, ...file.split("/")), "utf8") === content;
    } catch {
      return false;
    }
  });
}
