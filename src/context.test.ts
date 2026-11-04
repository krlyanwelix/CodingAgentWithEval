import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONTEXT_OPTIONS,
  compactHistory,
  elideLongToolResults,
  estimateMessagesTokens,
  estimateTokens,
  splitTurns,
  truncateToolOutput,
} from "./context.js";
import type { Message } from "./types.js";

function history(turns: number, filler: string): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "user", content: `question ${index} ${filler}` });
    messages.push({ role: "assistant", content: `answer ${index} ${filler}` });
  }
  return messages;
}

test("estimateTokens over-estimates CJK compared with latin text", () => {
  const cjk = estimateTokens("你好世界，这是一个测试。".repeat(4));
  const latin = estimateTokens("a".repeat(36));
  assert.ok(cjk > latin);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
});

test("splitTurns starts a new turn at every user message", () => {
  const messages: Message[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", content: "file", tool_call_id: "c" },
    { role: "assistant", content: "done" },
    { role: "user", content: "two" },
    { role: "assistant", content: "done" },
  ];
  const turns = splitTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].length, 4);
  assert.equal(turns[1].length, 2);
});

test("compactHistory drops the oldest turns and keeps the newest ones", () => {
  const messages = history(10, "padding ".repeat(30));
  const compacted = compactHistory(messages, { ...DEFAULT_CONTEXT_OPTIONS, keepRecentTurns: 2 }, 1500);
  assert.ok(compacted.droppedTurns > 0);
  assert.ok(compacted.messages.length < messages.length);
  assert.ok(compacted.digest.includes("第 1 轮"));
  const lastUser = [...compacted.messages].reverse().find((message) => message.role === "user");
  assert.match(String(lastUser?.content), /question 9/);
  assert.ok(compacted.estimatedTokens < estimateMessagesTokens(messages));
});

test("compactHistory always keeps at least keepRecentTurns turns", () => {
  const messages = history(6, "padding ".repeat(30));
  const compacted = compactHistory(messages, { ...DEFAULT_CONTEXT_OPTIONS, keepRecentTurns: 3 }, 10);
  assert.equal(compacted.droppedTurns, 3);
  assert.equal(splitTurns(compacted.messages).length, 3);
});

test("compactHistory leaves history untouched when it already fits", () => {
  const messages = history(2, "small");
  const compacted = compactHistory(messages, DEFAULT_CONTEXT_OPTIONS, 100_000);
  assert.equal(compacted.droppedTurns, 0);
  assert.equal(compacted.digest, "");
  assert.deepEqual(compacted.messages, messages);
});

test("truncateToolOutput keeps head and tail, and spills the full text to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-test-"));
  try {
    const text = `${"A".repeat(4000)}MIDDLE${"Z".repeat(1000)}`;
    const result = truncateToolOutput(
      text,
      { toolResultMaxChars: 1000, toolResultHeadChars: 600, toolResultTailChars: 300 },
      { dir, label: "bash" },
    );
    assert.ok(result.spilledTo);
    assert.equal(readFileSync(result.spilledTo!, "utf8"), text);
    assert.ok(result.text.includes("已截断"));
    assert.ok(result.text.length < text.length);
    assert.equal(result.fullLength, text.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncateToolOutput returns short output unchanged", () => {
  const result = truncateToolOutput("short", { toolResultMaxChars: 1000, toolResultHeadChars: 600, toolResultTailChars: 300 });
  assert.equal(result.text, "short");
  assert.equal(result.spilledTo, undefined);
});

test("elideLongToolResults only shortens oversized tool messages", () => {
  const long: Message = { role: "tool", content: "x".repeat(5000), tool_call_id: "c" };
  const short: Message = { role: "tool", content: "small", tool_call_id: "d" };
  const [elided, untouched] = elideLongToolResults([long, short], 1000);
  assert.ok(String(elided?.content).length < 1500);
  assert.ok(String(elided?.content).includes("已省略"));
  assert.equal(untouched?.content, "small");
});
