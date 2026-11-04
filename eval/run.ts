import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent } from "../src/agent.js";
import { setWorkspaceRoot, tools } from "../src/tools.js";
import { createModel, describeModel } from "../src/model-config.js";
import { buildSystemPrompt } from "../src/prompt.js";
import type { Message } from "../src/types.js";
import { evalTasks, selectTasks, type EvalTask } from "./tasks.js";

export interface TaskResult {
  id: string;
  pass: boolean;
  reward: number;
  detail: string;
  steps: number;
  elapsedMs: number;
  toolCalls: string[];
  warnings: string[];
  answerPreview: string;
  messages: Message[];
}

export interface RunSummary {
  runId: string;
  model: string;
  provider: string;
  skill: string | null;
  results: TaskResult[];
  passCount: number;
  total: number;
  elapsedMs: number;
}

export interface RunOptions {
  tasks: EvalTask[];
  skillPath?: string;
  repeat?: number;
  jsonlPath?: string;
  maxTurns?: number;
  quiet?: boolean;
}

/** Runs the agent over eval tasks, scores them, and appends one JSONL record per task. */
export async function runEval(options: RunOptions): Promise<RunSummary> {
  const { model, settings } = createModel(process.env);
  const repeat = options.repeat ?? 1;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = resolve(options.jsonlPath ?? "data/trajectories.jsonl");
  mkdirSync(resolve("data/eval"), { recursive: true });

  const skillText = options.skillPath ? readFileSync(resolve(options.skillPath), "utf8") : "";
  const skillBlock = options.skillPath
    ? `\n\n## Skill: ${options.skillPath}\nFollow this skill while working:\n${skillText}\n`
    : "";

  const systemPrompt = buildSystemPrompt(settings.model, []) + skillBlock;
  const results: TaskResult[] = [];
  const started = Date.now();

  for (const task of options.tasks) {
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      const sandbox = resolve("data/eval", runId, `${task.id}-${attempt}`);
      mkdirSync(sandbox, { recursive: true });
      // The repo is ESM ("type":"module"); sandboxes must be CJS unless a task says otherwise.
      const seedFiles = {
        "package.json": `${JSON.stringify({ name: "eval-task", type: "commonjs" }, null, 2)}\n`,
        ...(task.seed ?? {}),
      };
      for (const [file, content] of Object.entries(seedFiles)) {
        const target = join(sandbox, file);
        mkdirSync(resolve(target, ".."), { recursive: true });
        writeFileSync(target, content);
      }

      setWorkspaceRoot(sandbox);
      const agent = new Agent({
        model,
        tools,
        systemPrompt,
        maxTurns: options.maxTurns ?? 20,
        // Unattended runs: every tool call is pre-approved.
        confirmToolCall: async () => true,
      });

      const toolCalls: string[] = [];
      const warnings: string[] = [];
      let answer = "";
      const taskStarted = Date.now();
      let steps = 0;

      for await (const event of agent.run(task.prompt)) {
        if (event.type === "tool_start") {
          toolCalls.push(event.toolCall.function.name);
        } else if (event.type === "tool_end") {
          steps += 1;
        } else if (event.type === "warning") {
          warnings.push(event.message);
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          answer = event.message.content;
        }
      }

      const check = task.check(sandbox, answer);
      const result: TaskResult = {
        id: task.id,
        pass: check.pass,
        reward: check.pass ? 1 : 0,
        detail: check.detail,
        steps,
        elapsedMs: Date.now() - taskStarted,
        toolCalls,
        warnings,
        answerPreview: answer.slice(0, 500),
        messages: agent.getMessages().map((message) => ({
          role: message.role,
          content: (message.content ?? "").slice(0, 600),
          tool_calls: message.tool_calls?.map((call) => call.function.name),
        })) as Message[],
      };
      results.push(result);

      const record = {
        ts: new Date().toISOString(),
        runId,
        model: settings.model,
        provider: settings.provider,
        skill: options.skillPath ?? null,
        task: task.id,
        attempt,
        pass: result.pass,
        reward: result.reward,
        steps: result.steps,
        elapsedMs: result.elapsedMs,
        toolCalls: result.toolCalls,
        warnings: result.warnings,
        answer: result.answerPreview,
        messages: result.messages,
      };
      appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");

      if (!options.quiet) {
        const mark = result.pass ? "PASS" : "FAIL";
        console.log(
          `${mark} ${task.id}  steps=${result.steps}  ${(result.elapsedMs / 1000).toFixed(1)}s  tools=${result.toolCalls.join(">") || "-"}`,
        );
        if (!result.pass) {
          console.log(
            result.detail
              .split("\n")
              .map((line) => `     ${line}`)
              .join("\n"),
          );
        }
      }
    }
  }

  const summary: RunSummary = {
    runId,
    model: settings.model,
    provider: settings.provider,
    skill: options.skillPath ?? null,
    results,
    passCount: results.filter((result) => result.pass).length,
    total: results.length,
    elapsedMs: Date.now() - started,
  };

  if (!options.quiet) {
    console.log(
      `\n${describeModel(settings)} | skill=${options.skillPath ?? "-"} | ${summary.passCount}/${summary.total} passed | ${(summary.elapsedMs / 1000).toFixed(1)}s`,
    );
    console.log(`trajectories appended to ${jsonlPath}`);
  }
  return summary;
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    args.set(key, rest.join("=") || "true");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runEval({
    tasks: selectTasks(args.get("tasks") ?? "all"),
    skillPath: args.get("skill"),
    repeat: Number(args.get("repeat") ?? 1),
    jsonlPath: args.get("jsonl"),
    maxTurns: Number(args.get("max-turns") ?? 20),
  });
  if (summary.passCount !== summary.total) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve("eval/run.ts")) {
  await main();
}

// keep the import used for type clarity in editors that strip unused imports
export type { EvalTask };
void evalTasks;
void existsSync;
void tools;


