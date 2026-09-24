import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool } from "./types.js";

export const tools: Tool[] = [
  {
    definition: {
      name: "get_time",
      description: "Get the current local date and time.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      return new Date().toLocaleString();
    },
  },
  {
    definition: {
      name: "list_files",
      description: "List file and directory names in the current working directory (or a child directory).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative directory path; defaults to '.'" } },
        additionalProperties: false,
      },
    },
    async execute(args) {
      const path = typeof args === "object" && args !== null && "path" in args && typeof args.path === "string"
        ? args.path
        : ".";
      const root = resolve(process.cwd());
      const target = resolve(root, path);
      if (target !== root && !target.startsWith(`${root}/`) && !target.startsWith(`${root}\\`)) {
        throw new Error("Path must stay inside the current working directory");
      }
      return (await readdir(target, { withFileTypes: true }))
        .map((entry) => `${entry.isDirectory() ? "[dir] " : "      "}${entry.name}`)
        .join("\n") || "(empty directory)";
    },
  },
];
