import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import type { AgentEvent, Message, Model, Tool, ToolDefinition } from "./types.js";

/** Model double that returns scripted assistant messages and records every prompt. */
class ScriptedModel implements Model {
  readonly calls: Message[][] = [];

  constructor(private readonly script: Message[]) {}

  async complete(messages: Message[], _tools: ToolDefinition[]): Promise<Message> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

async function drain(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("the loop executes a tool call and feeds the result back to the model", async () => {
  const echo: Tool = {
    definition: {
      name: "echo",
      description: "Echo the value back.",
      parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
    },
    async execute(args) {
      const { value } = args as { value: number };
      return `ok:${value}`;
    },
  };
  const model = new ScriptedModel([
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":42}' } }],
    },
    { role: "assistant", content: "done" },
  ]);
  const agent = new Agent({ model, tools: [echo], systemPrompt: "sys" });

  const events = await drain(agent.run("hi"));

  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  // The status line rides on the tail of the last result; the payload must still lead.
  assert.ok(toolEnd.result.startsWith("ok:42"), toolEnd.result);

  const agentEnd = events.find((event) => event.type === "agent_end");
  assert.ok(agentEnd && agentEnd.type === "agent_end");
  assert.equal(agentEnd.message.content, "done");

  assert.equal(model.calls.length, 2);
  const secondPrompt = model.calls[1]!;
  assert.equal(secondPrompt[0]?.role, "system");
  assert.equal(secondPrompt.at(-1)?.role, "tool");
  assert.ok(secondPrompt.at(-1)?.content?.startsWith("ok:42"), String(secondPrompt.at(-1)?.content));
});

test("a failed tool returns an error string instead of breaking the run", async () => {
  const broken: Tool = {
    definition: { name: "broken", description: "Always throws.", parameters: { type: "object", properties: {} } },
    async execute() {
      throw new Error("kaboom");
    },
  };
  const model = new ScriptedModel([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "broken", arguments: "{}" } }] },
    { role: "assistant", content: "recovered" },
  ]);
  const agent = new Agent({ model, tools: [broken], systemPrompt: "sys" });

  const events = await drain(agent.run("try"));

  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.match(toolEnd.result, /^Tool error: kaboom/);
  assert.ok(events.some((event) => event.type === "agent_end"));
});

test("oversized tool output is truncated before it enters the history", async () => {
  const talkative: Tool = {
    definition: { name: "talkative", description: "Returns a lot.", parameters: { type: "object", properties: {} } },
    async execute() {
      return "x".repeat(20_000);
    },
  };
  const model = new ScriptedModel([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "talkative", arguments: "{}" } }] },
    { role: "assistant", content: "done" },
  ]);
  const agent = new Agent({
    model,
    tools: [talkative],
    systemPrompt: "sys",
    context: { toolResultMaxChars: 500, spillDir: undefined },
  });

  const events = await drain(agent.run("go"));

  const toolEnd = events.find((event) => event.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.ok(toolEnd.result.length < 20_000);
  assert.match(toolEnd.result, /已截断/);
  const toolMessage = agent.getMessages().find((message) => message.role === "tool");
  assert.ok(String(toolMessage?.content).length < 20_000);
});

test("old turns are compacted into a digest before the prompt is sent", async () => {
  const model = new ScriptedModel(Array.from({ length: 6 }, () => ({ role: "assistant" as const, content: "ok" })));
  const agent = new Agent({
    model,
    tools: [],
    systemPrompt: "sys",
    context: { maxInputTokens: 600, reserveTokens: 100, keepRecentTurns: 1, summaryMaxTokens: 200 },
  });

  for (let index = 0; index < 6; index += 1) {
    await drain(agent.run(`question ${index} ${"padding ".repeat(40)}`));
  }

  const lastPrompt = model.calls.at(-1)!;
  assert.match(String(lastPrompt[0]?.content), /\[已压缩的早期对话摘要\]/);
  assert.match(String(lastPrompt[0]?.content), /用户: question/);
  assert.equal(lastPrompt.at(-1)?.role, "user");
  const uncompactedLength = 1 + 6 * 2;
  assert.ok(lastPrompt.length < uncompactedLength, `expected compaction, got ${lastPrompt.length} of ${uncompactedLength} messages`);
});

test("aborting the signal ends the run with an aborted event, not an error", async () => {
  const slow: Tool = {
    definition: { name: "slow", description: "Waits for cancellation.", parameters: { type: "object", properties: {} } },
    async execute(_args, context) {
      while (!context?.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("cancelled");
    },
  };
  const model = new ScriptedModel([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] },
  ]);
  const agent = new Agent({ model, tools: [slow], systemPrompt: "sys" });
  const controller = new AbortController();

  const events: AgentEvent[] = [];
  for await (const event of agent.run("go", { signal: controller.signal })) {
    events.push(event);
    if (event.type === "tool_start") controller.abort();
  }

  assert.ok(events.some((event) => event.type === "aborted"));
  assert.ok(!events.some((event) => event.type === "error"));
  assert.ok(!events.some((event) => event.type === "agent_end"));
});

test("an aborted model call is reported with the partial text that streamed", async () => {
  const controller = new AbortController();
  const model: Model = {
    async complete() {
      throw new Error("unused");
    },
    async *stream() {
      yield { type: "text_delta" as const, text: "half an ans" };
      controller.abort();
      yield { type: "message" as const, message: { role: "assistant" as const, content: "half an answer" } };
    },
  };
  const agent = new Agent({ model, tools: [], systemPrompt: "sys" });
  const events = await drain(agent.run("go", { signal: controller.signal }));
  const aborted = events.find((event) => event.type === "aborted");
  assert.ok(aborted && aborted.type === "aborted");
  assert.equal(aborted.partial, "half an ans");
});

test("a model that stops at its output limit produces a truncation warning", async () => {
  const model = new ScriptedModel([{ role: "assistant", content: "cut off here", finishReason: "length" }]);
  const agent = new Agent({ model, tools: [], systemPrompt: "sys" });
  const events = await drain(agent.run("go"));
  const warning = events.find((event) => event.type === "warning");
  assert.ok(warning && warning.type === "warning");
  assert.match(warning.message, /output limit/);
  assert.ok(events.some((event) => event.type === "agent_end"));
});

test("an empty answer produces a warning instead of ending silently", async () => {
  const model = new ScriptedModel([{ role: "assistant", content: "" }]);
  const agent = new Agent({ model, tools: [], systemPrompt: "sys" });
  const events = await drain(agent.run("go"));
  const warning = events.find((event) => event.type === "warning");
  assert.ok(warning && warning.type === "warning");
  assert.match(warning.message, /empty answer/);
});

test("the exact same tool call twice in a row is skipped, not executed", async () => {
  let executed = 0;
  const counter: Tool = {
    definition: { name: "counter", description: "Counts calls.", parameters: { type: "object", properties: {} } },
    async execute() {
      executed += 1;
      return `count:${executed}`;
    },
  };
  const call = (id: string): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "counter", arguments: "{}" } }],
  });
  const model = new ScriptedModel([call("c1"), call("c2"), { role: "assistant", content: "done" }]);
  const agent = new Agent({ model, tools: [counter], systemPrompt: "sys" });

  const events = await drain(agent.run("go"));

  const results = events.filter((event) => event.type === "tool_end").map((event) => (event as { result: string }).result);
  assert.equal(executed, 1);
  assert.equal(results.length, 2);
  assert.match(results[1]!, /Skipped/);
});

test("two failures in a row add a change-approach hint", async () => {
  const broken: Tool = {
    definition: { name: "broken", description: "Always throws.", parameters: { type: "object", properties: { n: { type: "integer" } } } },
    async execute() {
      throw new Error("nope");
    },
  };
  const call = (id: string, n: number): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "broken", arguments: `{"n":${n}}` } }],
  });
  const model = new ScriptedModel([call("c1", 1), call("c2", 2), { role: "assistant", content: "gave up" }]);
  const agent = new Agent({ model, tools: [broken], systemPrompt: "sys" });

  const events = await drain(agent.run("go"));
  const results = events.filter((event) => event.type === "tool_end").map((event) => (event as { result: string }).result);
  assert.match(results[0]!, /^Tool error: nope/);
  assert.doesNotMatch(results[0]!, /Corrective:/);
  assert.match(results[1]!, /Corrective: .*two tool calls failed/);
});

test("tool calls in one step run concurrently but report in call order", async () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const slow: Tool = {
    definition: { name: "slow", description: "Waits.", parameters: { type: "object", properties: {} } },
    async execute() {
      await sleep(120);
      return "slow done";
    },
  };
  const fast: Tool = {
    definition: { name: "fast", description: "Answers at once.", parameters: { type: "object", properties: {} } },
    async execute() {
      await sleep(10);
      return "fast done";
    },
  };
  const model = new ScriptedModel([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "slow", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "fast", arguments: "{}" } },
      ],
    },
    { role: "assistant", content: "both done" },
  ]);
  const agent = new Agent({ model, tools: [slow, fast], systemPrompt: "sys" });

  const started = Date.now();
  const events = await drain(agent.run("go"));
  const elapsed = Date.now() - started;

  const ends = events.filter((event) => event.type === "tool_end").map((event) => (event as { result: string }).result);
  assert.deepEqual(
    ends.map((result) => result.split("\n\n[harness]")[0]),
    ["slow done", "fast done"],
  );
  assert.ok(elapsed < 220, `calls should overlap, took ${elapsed}ms`);

  // Both results land in the next prompt, in call order.
  const prompt = model.calls[1]!;
  assert.deepEqual(
    prompt.slice(-2).map((message) => String(message.content).split("\n\n[harness]")[0]),
    ["slow done", "fast done"],
  );
});

test("three failed tool calls stop the run instead of looping", async () => {
  const broken: Tool = {
    definition: { name: "broken", description: "Always throws.", parameters: { type: "object", properties: { n: { type: "integer" } } } },
    async execute() {
      throw new Error("nope");
    },
  };
  const call = (id: string, n: number): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "broken", arguments: `{"n":${n}}` } }],
  });
  const model = new ScriptedModel([call("c1", 1), call("c2", 2), call("c3", 3), call("c4", 4)]);
  const agent = new Agent({ model, tools: [broken], systemPrompt: "sys" });

  const events = await drain(agent.run("go"));
  const results = events.filter((event) => event.type === "tool_end");
  assert.equal(results.length, 3);
  const warning = events.find((event) => event.type === "warning");
  assert.ok(warning && warning.type === "warning");
  assert.match(warning.message, /three tool calls failed/i);
  const end = events.find((event) => event.type === "agent_end");
  assert.ok(end && end.type === "agent_end");
  assert.match(String(end.message.content), /^\[harness\]/);
  assert.equal(model.calls.length, 3);
});

test("repeating the same tool call stops the run after the second skip", async () => {
  const tool: Tool = {
    definition: { name: "counter", description: "Counts.", parameters: { type: "object", properties: {} } },
    async execute() {
      return "counted";
    },
  };
  const call = (id: string): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "counter", arguments: "{}" } }],
  });
  const model = new ScriptedModel([call("c1"), call("c2"), call("c3"), call("c4")]);
  const agent = new Agent({ model, tools: [tool], systemPrompt: "sys" });

  const events = await drain(agent.run("go"));
  const warning = events.find((event) => event.type === "warning");
  assert.ok(warning && warning.type === "warning");
  assert.match(warning.message, /repeated the same tool call/i);
  const results = events.filter((event) => event.type === "tool_end").map((event) => (event as { result: string }).result);
  assert.equal(results.length, 3);
  assert.match(results[1]!, /Skipped/);
});

test("hitting the turn limit ends the run with a harness answer instead of throwing", async () => {
  const tool: Tool = {
    definition: { name: "tick", description: "Ticks.", parameters: { type: "object", properties: {} } },
    async execute() {
      return "tick";
    },
  };
  const call = (id: string): Message => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "tick", arguments: `{"id":"${id}"}` } }],
  });
  const model = new ScriptedModel([call("a"), call("b"), call("c"), call("d")]);
  const agent = new Agent({ model, tools: [tool], systemPrompt: "sys", maxTurns: 2 });

  const events = await drain(agent.run("go"));
  const warning = events.find((event) => event.type === "warning");
  assert.ok(warning && warning.type === "warning");
  assert.match(warning.message, /turn limit/i);
  const end = events.find((event) => event.type === "agent_end");
  assert.ok(end && end.type === "agent_end");
  assert.match(String(end.message.content), /Reached the 2-turn limit/);
});

test("an oversized recent tool result is shrunk instead of failing the run", async () => {
  const big: Tool = {
    definition: { name: "big", description: "Returns a huge string.", parameters: { type: "object", properties: {} } },
    async execute() {
      return "x".repeat(8000);
    },
  };
  const model = new ScriptedModel([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "big", arguments: "{}" } }] },
    { role: "assistant", content: "ok" },
  ]);
  const agent = new Agent({
    model,
    tools: [big],
    systemPrompt: "sys",
    context: { maxInputTokens: 400, reserveTokens: 100, keepRecentTurns: 3, summaryMaxTokens: 100 },
  });

  const events = await drain(agent.run("go"));
  const end = events.find((event) => event.type === "agent_end");
  assert.ok(end && end.type === "agent_end");
  assert.equal(end.message.content, "ok");
  assert.equal(model.calls.length, 2);
  const payloadChars = (model.calls[1] ?? []).reduce((sum, message) => sum + String(message.content ?? "").length, 0);
  assert.ok(payloadChars < 4000, `payload should be shrunk, got ${payloadChars}`);
});
