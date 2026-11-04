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
  assert.equal(toolEnd.result, "ok:42");

  const agentEnd = events.find((event) => event.type === "agent_end");
  assert.ok(agentEnd && agentEnd.type === "agent_end");
  assert.equal(agentEnd.message.content, "done");

  assert.equal(model.calls.length, 2);
  const secondPrompt = model.calls[1]!;
  assert.equal(secondPrompt[0]?.role, "system");
  assert.equal(secondPrompt.at(-1)?.role, "tool");
  assert.equal(secondPrompt.at(-1)?.content, "ok:42");
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
