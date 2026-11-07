import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool, ToolContext } from "./types.js";

let workspaceRoot = resolve(process.cwd());

/** Points the built-in tools at another directory (used by the eval harness). */
export function setWorkspaceRoot(directory: string): void {
  workspaceRoot = resolve(directory);
}
const execFileAsync = promisify(execFile);

export function findBash(): string | undefined {
  if (process.platform !== "win32") return "/bin/bash";
  const git = whereExecutable("git");
  // <root>\cmd\git.exe -> <root>\bin\bash.exe
  const fromGit = git ? join(dirname(dirname(git)), "bin", "bash.exe") : undefined;
  // Install locations win over PATH: `where bash` often finds the WSL launcher
  // (C:\Windows\System32\bash.exe), which is not Git Bash.
  const installs = [
    process.env.GIT_BASH_PATH,
    fromGit,
    "E:\\Git\\bin\\bash.exe",
    "D:\\Git\\bin\\bash.exe",
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter((path): path is string => Boolean(path));
  const installed = installs.find((path) => existsSync(path));
  if (installed) return installed;
  const fromPath = whereExecutable("bash");
  if (!fromPath || /\\Windows\\System32\\|\\WindowsApps\\/i.test(fromPath)) return undefined;
  return existsSync(fromPath) ? fromPath : undefined;
}

/** First line of `where <name>`, or undefined when the executable is not on PATH. */
function whereExecutable(name: string): string | undefined {
  try {
    const output = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * True when the nearest existing ancestor still resolves inside the workspace.
 * Checked on the ancestor so writing a new file is judged by its directory, and
 * on the file itself so a link pointing out of the workspace is caught.
 */
function insideWorkspace(target: string): boolean {
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const rel = relative(realpathOrSelf(workspaceRoot), realpathOrSelf(probe));
  return !(isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep));
}

function workspacePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("path must be a non-empty string");
  const target = resolve(workspaceRoot, value);
  const rel = relative(workspaceRoot, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith(`../`)) {
    throw new Error("path must stay inside the current working directory");
  }
  // Lexical checks alone miss links: a junction inside the workspace can still
  // point outside of it.
  if (!insideWorkspace(target)) {
    throw new Error("path resolves outside the current working directory through a link");
  }
  return target;
}

function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("tool arguments must be an object");
  return args as Record<string, unknown>;
}

/** Directories that never contain source worth scanning, and are huge. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "data",
]);

function isIgnoredName(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.endsWith(".lock");
}

/**
 * Depth-first file walk under `root`, bounded by count and depth. Symlinked
 * directories are skipped: following them is how a glob turns into an infinite
 * loop or escapes the workspace.
 */
function walkFiles(root: string, limit: number, maxDepth = 12): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (directory: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (isIgnoredName(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  visit(root, 0);
  return { files, truncated };
}

/** Translate a small glob dialect (`**`, `*`, `?`) into a RegExp over POSIX paths. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (".+^${}()|[]\\".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** The three small file tools used by a coding agent: read, write, and edit. */
export const tools: Tool[] = [
  {
    definition: {
      name: "read",
      description: "Read a UTF-8 text file. Use offset and limit (in lines) for large files.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
    },
    async execute(args) {
      const input = objectArgs(args);
      const path = workspacePath(input.path);
      const text = await readFile(path, "utf8");
      const offset = typeof input.offset === "number" ? Math.max(1, Math.floor(input.offset)) : 1;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : undefined;
      const lines = text.split(/\r?\n/).slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit);
      const body = lines.map((line, index) => `${offset + index}: ${line}`).join("\n");
      return `${body}\n（行号 "N: " 只是显示用的，不属于文件内容；edit 的 oldText 不要包含它）`;
    },
  },
  {
    definition: {
      name: "write",
      description: "Create or overwrite a UTF-8 text file. Parent directories must already exist.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
    },
    async execute(args) {
      const input = objectArgs(args);
      const path = workspacePath(input.path);
      if (typeof input.content !== "string") throw new Error("content must be a string");
      await writeFile(path, input.content, "utf8");
      return `Wrote ${input.content.length} characters to ${input.path}`;
    },
  },
  {
    definition: {
      name: "edit",
      description: "Replace one exact string in a UTF-8 text file. Fails if the old text is not found or is ambiguous.",
      parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false },
    },
    async execute(args) {
      const input = objectArgs(args);
      const path = workspacePath(input.path);
      if (typeof input.oldText !== "string" || typeof input.newText !== "string") throw new Error("oldText and newText must be strings");
      const text = await readFile(path, "utf8");
      const occurrences = text.split(input.oldText).length - 1;
      if (occurrences === 0) throw new Error("oldText was not found");
      if (occurrences > 1) throw new Error("oldText must match exactly once");
      await writeFile(path, text.replace(input.oldText, input.newText), "utf8");
      return `Edited ${input.path}`;
    },
  },
  {
    definition: {
      name: "bash",
      description: "Run a command in the local Git Bash shell. Commands run in the workspace directory; use timeoutMs for long-running commands.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, description: "Timeout in milliseconds (default: 30000)" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    requiresConfirmation: true,
    async execute(args, context?: ToolContext) {
      const input = objectArgs(args);
      if (typeof input.command !== "string" || input.command.trim() === "") throw new Error("command must be a non-empty string");
      const bash = findBash();
      if (!bash) {
        return (
          "Git Bash was not found. Set GIT_BASH_PATH to the full path of bash.exe " +
          "(for example E:\\Git\\bin\\bash.exe), or install Git for Windows from " +
          "https://git-scm.com/download/win and restart the agent."
        );
      }
      const timeout = typeof input.timeoutMs === "number" ? Math.min(120000, Math.max(1000, Math.floor(input.timeoutMs))) : 30000;
      try {
        const result = await execFileAsync(bash, ["-lc", input.command], {
          cwd: workspaceRoot,
          timeout,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          signal: context?.signal,
        });
        return [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : "", `exit_code: 0`].filter(Boolean).join("\n").trim();
      } catch (cause) {
        // Cancellation must propagate as a cancellation, not as a "command failed" string.
        if (context?.signal?.aborted) throw cause;
        const error = cause as { stdout?: string; stderr?: string; code?: string | number; killed?: boolean; message?: string };
        return [
          error.stdout,
          error.stderr ? `stderr:\n${error.stderr}` : "",
          `exit_code: ${error.code ?? "unknown"}${error.killed ? " (timed out)" : ""}`,
          !error.stdout && !error.stderr ? error.message : "",
        ].filter(Boolean).join("\n").trim();
      }
    },
  },
  {
    definition: {
      name: "glob",
      description: "Find files by path pattern (supports **, * and ?). Paths are relative to the searched directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: 'Glob such as "src/**/*.ts" or "*.md"' },
          path: { type: "string", description: "Directory to search, relative to the workspace (default: .)" },
          maxResults: { type: "integer", minimum: 1, maximum: 1000, description: "Default 200" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      const input = objectArgs(args);
      if (typeof input.pattern !== "string" || input.pattern.trim() === "") throw new Error("pattern must be a non-empty string");
      const base = workspacePath(typeof input.path === "string" ? input.path : ".");
      const limit = typeof input.maxResults === "number" ? Math.min(1000, Math.max(1, Math.floor(input.maxResults))) : 200;
      const matcher = globToRegExp(input.pattern.trim());
      const { files, truncated } = walkFiles(base, 4000);
      const matched = files.filter((file) => matcher.test(file));
      const matches = matched.slice(0, limit);
      if (matches.length === 0) return `No file matched ${input.pattern} under ${relative(workspaceRoot, base) || "."}.`;
      const more = matched.length > matches.length || truncated;
      return `${matches.join("\n")}\n(${matches.length} files${more ? "; more matches exist — narrow the pattern" : ""})`;
    },
  },
  {
    definition: {
      name: "grep",
      description: "Search file contents with a JavaScript regular expression and print path:line: text. Skips binaries and dependency directories.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          glob: { type: "string", description: 'Optional file filter, e.g. "*.ts" or "src/**/*.js"' },
          path: { type: "string", description: "Directory to search, relative to the workspace (default: .)" },
          caseSensitive: { type: "boolean", description: "Default false" },
          maxMatches: { type: "integer", minimum: 1, maximum: 500, description: "Default 100" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      const input = objectArgs(args);
      if (typeof input.pattern !== "string" || input.pattern === "") throw new Error("pattern must be a non-empty string");
      const maxMatches = typeof input.maxMatches === "number" ? Math.min(500, Math.max(1, Math.floor(input.maxMatches))) : 100;
      const caseSensitive = input.caseSensitive === true;
      let expression: RegExp;
      try {
        expression = new RegExp(input.pattern, caseSensitive ? "" : "i");
      } catch (cause) {
        throw new Error(`invalid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const base = workspacePath(typeof input.path === "string" ? input.path : ".");
      const fileFilter = typeof input.glob === "string" && input.glob.trim() ? input.glob.trim() : undefined;
      const matcher = fileFilter ? globToRegExp(fileFilter) : undefined;
      const { files, truncated } = walkFiles(base, 5000);
      const results: string[] = [];
      let scanned = 0;
      let skippedBinary = 0;
      for (const file of files) {
        if (results.length >= maxMatches) break;
        if (matcher) {
          const target = fileFilter!.includes("/") ? file : file.split("/").pop()!;
          if (!matcher.test(target)) continue;
        }
        const absolute = join(base, ...file.split("/"));
        try {
          if (statSync(absolute).size > 2 * 1024 * 1024) continue;
          const buffer = readFileSync(absolute);
          if (buffer.subarray(0, 4096).includes(0)) {
            skippedBinary += 1;
            continue;
          }
          scanned += 1;
          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let index = 0; index < lines.length && results.length < maxMatches; index += 1) {
            const line = lines[index]!;
            if (line.length > 400) continue;
            if (!expression.test(line)) continue;
            results.push(`${file}:${index + 1}: ${line.trim().slice(0, 240)}`);
          }
        } catch {
          // Unreadable or vanished mid-scan: skip it, the pattern may match elsewhere.
        }
      }
      if (results.length === 0) return `No match for ${input.pattern}${fileFilter ? ` in ${fileFilter}` : ""} (${scanned} files scanned).`;
      return `${results.join("\n")}\n(${results.length} matches in ${scanned} files${results.length >= maxMatches ? "; capped" : ""}${truncated ? "; file walk capped" : ""}${skippedBinary ? `; ${skippedBinary} binaries skipped` : ""})`;
    },
  },
];
