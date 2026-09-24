import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Tool } from "./types.js";

const workspaceRoot = resolve(process.cwd());
const execFileAsync = promisify(execFile);

function findBash(): string | undefined {
  if (process.platform !== "win32") return "/bin/bash";
  const candidates = [
    process.env.GIT_BASH_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path));
}

function workspacePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("path must be a non-empty string");
  const target = resolve(workspaceRoot, value);
  const rel = relative(workspaceRoot, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith(`../`)) {
    throw new Error("path must stay inside the current working directory");
  }
  return target;
}

function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("tool arguments must be an object");
  return args as Record<string, unknown>;
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
      return lines.map((line, index) => `${offset + index}: ${line}`).join("\n");
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
    async execute(args) {
      const input = objectArgs(args);
      if (typeof input.command !== "string" || input.command.trim() === "") throw new Error("command must be a non-empty string");
      const bash = findBash();
      if (!bash) {
        return "Git Bash was not found. Install Git for Windows from https://git-scm.com/download/win, then restart the agent. On Windows you can also ask the user to run: winget install --id Git.Git -e";
      }
      const timeout = typeof input.timeoutMs === "number" ? Math.min(120000, Math.max(1000, Math.floor(input.timeoutMs))) : 30000;
      try {
        const result = await execFileAsync(bash, ["-lc", input.command], {
          cwd: workspaceRoot,
          timeout,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : "", `exit_code: 0`].filter(Boolean).join("\n").trim();
      } catch (cause) {
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
];
