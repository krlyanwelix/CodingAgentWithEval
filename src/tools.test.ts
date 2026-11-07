import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { findBash, globToRegExp, tools } from "./tools.js";
import type { Tool } from "./types.js";

function tool(name: string): Tool {
  const found = tools.find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

test("read numbers the requested line range", async () => {
  const result = await tool("read").execute({ path: "package.json", limit: 3 });
  const lines = result.split("\n").filter((line) => !line.startsWith("（"));
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^1: \{/);
  assert.match(lines[1]!, /^2: +"name"/);
});

test("read warns that the line-number prefix is not file content", async () => {
  const result = await tool("read").execute({ path: "package.json", limit: 2 });
  assert.match(result, /行号/);
  assert.match(result, /oldText/);
});

test("read refuses paths outside the workspace", async () => {
  await assert.rejects(tool("read").execute({ path: "../outside.txt" }), /inside the current working directory/);
  await assert.rejects(tool("read").execute({ path: join("..", "..", "Windows", "win.ini") }), /inside/);
});

test("findBash locates this machine's Git Bash", (context) => {
  const bash = findBash();
  if (!bash) {
    context.skip("Git Bash is not installed");
    return;
  }
  assert.ok(existsSync(bash), `bash not found at ${bash}`);
  assert.match(bash, /bash\.exe$/i);
});

test("read refuses a junction that points outside the workspace", async (context) => {
  if (process.platform !== "win32") {
    context.skip("junctions are Windows-only");
    return;
  }
  const relativePath = join("data", `escape-${randomUUID()}`);
  const linkPath = join(process.cwd(), relativePath);
  execFileSync("cmd.exe", ["/c", "mklink", "/J", linkPath, tmpdir()], { windowsHide: true });
  try {
    await assert.rejects(tool("read").execute({ path: join(relativePath, "probe.txt") }), /through a link/);
  } finally {
    rmdirSync(linkPath);
  }
});

test("write then edit then read round-trips through the file tools", async () => {
  const relativePath = join("data", `tool-test-${randomUUID()}.txt`);
  try {
    await tool("write").execute({ path: relativePath, content: "alpha\nbeta\n" });
    await tool("edit").execute({ path: relativePath, oldText: "beta", newText: "gamma" });
    const content = await tool("read").execute({ path: relativePath });
    assert.match(content, /1: alpha/);
    assert.match(content, /2: gamma/);
  } finally {
    rmSync(join(process.cwd(), relativePath), { force: true });
  }
});

test("edit fails when the old text is missing or ambiguous", async () => {
  const relativePath = join("data", `tool-test-${randomUUID()}.txt`);
  try {
    await tool("write").execute({ path: relativePath, content: "same same" });
    await assert.rejects(tool("edit").execute({ path: relativePath, oldText: "nope", newText: "x" }), /not found/);
    await assert.rejects(tool("edit").execute({ path: relativePath, oldText: "same", newText: "x" }), /exactly once/);
  } finally {
    rmSync(join(process.cwd(), relativePath), { force: true });
  }
});

test("bash reports a command's output and exit code", async (context) => {
  const result = await tool("bash").execute({ command: "echo hello-from-agent" });
  if (result.includes("Git Bash was not found")) {
    context.skip("Git Bash is not installed");
    return;
  }
  assert.match(result, /hello-from-agent/);
  assert.match(result, /exit_code: 0/);
});

test("bash reports a non-zero exit code instead of throwing", async (context) => {
  const result = await tool("bash").execute({ command: "exit 3" });
  if (result.includes("Git Bash was not found")) {
    context.skip("Git Bash is not installed");
    return;
  }
  assert.match(result, /exit_code: 3/);
});

test("bash keeps the workspace as its working directory", async (context) => {
  const result = await tool("bash").execute({ command: "pwd" });
  if (result.includes("Git Bash was not found")) {
    context.skip("Git Bash is not installed");
    return;
  }
  assert.match(result.replace(/\//g, "\\").toLowerCase(), /myagentproject/);
});

test("glob patterns translate to anchored regular expressions", () => {
  const ts = globToRegExp("src/**/*.ts");
  assert.match("src/a.ts", ts);
  assert.match("src/deep/nested/b.ts", ts);
  assert.doesNotMatch("test/a.ts", ts);
  assert.match("README.md", globToRegExp("*.md"));
  assert.doesNotMatch("docs/README.md", globToRegExp("*.md"));
});

test("glob lists files under the workspace", async () => {
  const result = await tool("glob").execute({ pattern: "src/harness/*.ts" });
  assert.match(result, /src\/harness\/policy\.ts|src\\harness\\policy\.ts/);
  assert.match(result, /src\/harness\/verify\.ts|src\\harness\\verify\.ts/);
});

test("grep reports file and line for each match", async () => {
  const result = await tool("grep").execute({ pattern: "export function globToRegExp", path: "src" });
  assert.match(result, /tools\.ts:\d+: export function globToRegExp/);
  const needle = ["zzz", "no", "such", "symbol"].join("_");
  const empty = await tool("grep").execute({ pattern: needle, path: "src" });
  assert.match(empty, /No match for/);
});
