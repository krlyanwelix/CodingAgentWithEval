import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Agent } from "../src/agent.js";
import { setWorkspaceRoot, tools } from "../src/tools.js";
import { createModel, describeModel } from "../src/model-config.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { TraceRecorder } from "../src/harness/trace.js";
import type { Message } from "../src/types.js";
import type { EvalTask } from "./tasks.js";
import { computeDiff } from "./diff.js";
import { judgeAttempt, readJudgeSettings, type JudgeSettings, type JudgeVerdict } from "./judge.js";
import { layersPass, rubricFor, runRules, type RuleResult } from "./verifiers.js";
import { writeReport } from "./report.js";

/**
 * The evaluation runner.
 *
 * One attempt = a fresh directory seeded from the task, one agent run, then the
 * verifier stack: L0 task assertion, L1 deterministic rules, L2 judge. Every
 * layer is recorded, so a pass can be explained and a failure attributed.
 */

export interface TaskResult {
  id: string;
  title: string;
  pass: boolean;
  reward: number;
  detail: string;
  steps: number;
  elapsedMs: number;
  toolCalls: string[];
  warnings: string[];
  answerPreview: string;
  /** L0 assertion result. */
  l0: boolean;
  rules: RuleResult[];
  changed: string[];
  judge?: JudgeVerdict;
  judgeError?: string;
  firstError?: string;
  promptTokens: number;
  completionTokens: number;
  tracePath?: string;
}

export interface TaskAggregate {
  id: string;
  attempts: number;
  passes: number;
  /** Fraction of attempts that passed; the reward to mine from trajectories. */
  reward: number;
  pass: boolean;
}

export interface RunMetrics {
  passAt1: number;
  passAtK: number;
  /** Fraction of tasks where every attempt passed: the reliability number. */
  passHatK: number;
  majorityPass: number;
  meanReward: number;
  promptTokens: number;
  completionTokens: number;
  judgePromptTokens: number;
  judgeCompletionTokens: number;
  judgeScored: number;
  judgePassRate: number;
  judgeDisagreements: number;
  firstErrors: Record<string, number>;
}

export interface RunSummary {
  runId: string;
  model: string;
  skill: string | null;
  judgeModel: string | null;
  results: TaskResult[];
  aggregates: TaskAggregate[];
  metrics: RunMetrics;
  passCount: number;
  total: number;
  elapsedMs: number;
  reportPath?: string;
}

export interface RunOptions {
  tasks: EvalTask[];
  skillPath?: string;
  repeat?: number;
  jsonlPath?: string;
  maxTurns?: number;
  quiet?: boolean;
  /** false disables the judge; omitted means "on when JUDGE_API_KEY is set". */
  judge?: boolean;
  judgeSamples?: number;
  /** Judge verdict becomes part of the pass/fail gate (only after calibration). */
  gateJudge?: boolean;
}

function writeSeed(directory: string, seed: Record<string, string>): void {
  for (const [file, content] of Object.entries(seed)) {
    const target = join(directory, ...file.split("/"));
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

function attributeFailure(result: {
  runError: string;
  l0: boolean;
  rules: RuleResult[];
  warnings: string[];
}): string | undefined {
  if (result.runError) {
    if (/Context budget exceeded/i.test(result.runError)) return "harness:context-budget";
    if (/Model API|Cannot reach the model API|fetch failed/i.test(result.runError)) return "provider";
    return "harness:error";
  }
  if (result.warnings.some((warning) => /turn limit/i.test(warning))) return "model:turn-limit";
  if (result.warnings.some((warning) => /failed in a row|repeated the same tool call/i.test(warning))) {
    return "model:no-progress";
  }
  if (!result.l0) return "model:wrong-solution";
  if (result.rules.some((rule) => rule.gate && !rule.pass)) return "verification:rule";
  return undefined;
}

export async function runEval(options: RunOptions): Promise<RunSummary> {
  const { model, settings } = createModel(process.env);
  const repeat = Math.max(1, options.repeat ?? 1);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = resolve(options.jsonlPath ?? "data/trajectories.jsonl");
  const runDir = resolve("data/eval", runId);
  mkdirSync(runDir, { recursive: true });

  const judgeSettings: JudgeSettings | undefined = options.judge === false ? undefined : readJudgeSettings(process.env);
  if (judgeSettings && options.judgeSamples) judgeSettings.samples = Math.max(1, Math.min(5, options.judgeSamples));
  if (options.judge === true && !judgeSettings) throw new Error("--judge was requested but JUDGE_API_KEY is not set.");

  const skillText = options.skillPath ? readFileSync(resolve(options.skillPath), "utf8") : "";
  const skillBlock = options.skillPath
    ? `\n\n## Skill: ${options.skillPath}\nFollow this skill while working:\n${skillText}\n`
    : "";
  const systemPrompt = buildSystemPrompt(settings.model, []) + skillBlock;

  const results: TaskResult[] = [];
  const started = Date.now();

  for (const task of options.tasks) {
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      const sandbox = resolve(runDir, `${task.id}-${attempt}`);
      mkdirSync(sandbox, { recursive: true });
      // The repo is ESM ("type":"module"); sandboxes must be CJS unless a task says otherwise.
      const seed: Record<string, string> = {
        "package.json": `${JSON.stringify({ name: "eval-task", type: "commonjs" }, null, 2)}\n`,
        ...(task.seed ?? {}),
      };
      writeSeed(sandbox, seed);

      setWorkspaceRoot(sandbox);
      const trace = new TraceRecorder(resolve(runDir, "traces", `${task.id}-${attempt}.jsonl`), `${task.id}-${attempt}`);
      const agent = new Agent({
        model,
        tools,
        systemPrompt,
        maxTurns: options.maxTurns ?? 20,
        // Unattended runs: every tool call is pre-approved.
        confirmToolCall: async () => true,
        policy: { autoApproveRisk: "high" },
        trace,
      });

      const toolCalls: string[] = [];
      const warnings: string[] = [];
      let answer = "";
      const taskStarted = Date.now();
      let steps = 0;

      let runError = "";
      try {
        for await (const event of agent.run(task.prompt)) {
          if (event.type === "tool_start") {
            toolCalls.push(event.toolCall.function.name);
          } else if (event.type === "tool_end") {
            steps += 1;
          } else if (event.type === "warning") {
            warnings.push(event.message);
          } else if (event.type === "message_end" && event.message.role === "assistant") {
            answer = event.message.content ?? "";
          }
        }
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      }

      const check = runError
        ? { pass: false, detail: `run failed: ${runError}` }
        : task.check(sandbox, answer);
      const { changed, diff } = computeDiff(seed, sandbox);
      const rules = runRules({ task, seed, changed, answer, diff });
      const l0 = check.pass;
      const objectivePass = layersPass(l0, rules);

      let judge: JudgeVerdict | undefined;
      let judgeError: string | undefined;
      if (judgeSettings) {
        const judged = await judgeAttempt(
          {
            taskId: task.id,
            title: task.title,
            prompt: task.prompt,
            answer,
            diff,
            checks: [
              { name: "task-check", pass: check.pass, output: check.detail },
              ...rules.map((rule) => ({ name: rule.name, pass: rule.pass, output: rule.detail })),
            ],
            rubric: rubricFor(task),
          },
          judgeSettings,
        );
        judge = judged.verdict;
        judgeError = judged.error;
      }

      const pass = objectivePass && (!options.gateJudge || judge?.pass !== false);
      const tokens = agent.getMessages().reduce(
        (sum, message: Message) => ({
          prompt: sum.prompt + (message.usage?.promptTokens ?? 0),
          completion: sum.completion + (message.usage?.completionTokens ?? 0),
        }),
        { prompt: 0, completion: 0 },
      );
      const result: TaskResult = {
        id: task.id,
        title: task.title,
        pass,
        reward: pass ? 1 : 0,
        detail: check.detail,
        steps,
        elapsedMs: Date.now() - taskStarted,
        toolCalls,
        warnings,
        answerPreview: answer.slice(0, 500),
        l0,
        rules,
        changed,
        ...(judge ? { judge } : {}),
        ...(judgeError ? { judgeError } : {}),
        ...(pass ? {} : { firstError: attributeFailure({ runError, l0, rules, warnings }) }),
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        tracePath: trace.path,
      };
      results.push(result);
      trace.close();

      const record = {
        ts: new Date().toISOString(),
        runId,
        model: settings.model,
        skill: options.skillPath ?? null,
        task: task.id,
        attempt,
        pass: result.pass,
        reward: result.reward,
        l0: result.l0,
        rules: result.rules,
        changed: result.changed,
        judge: result.judge ?? null,
        judgeError: result.judgeError ?? null,
        firstError: result.firstError ?? null,
        steps: result.steps,
        elapsedMs: result.elapsedMs,
        toolCalls: result.toolCalls,
        warnings: result.warnings,
        answer: result.answerPreview,
      };
      appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");

      if (!options.quiet) {
        const mark = result.pass ? "PASS" : "FAIL";
        const judgeMark = judge ? ` judge=${judge.pass ? "pass" : "fail"}(${judge.score.toFixed(2)})` : "";
        console.log(
          `${mark} ${task.id}#${attempt}  steps=${result.steps}  ${(result.elapsedMs / 1000).toFixed(1)}s${judgeMark}  tools=${result.toolCalls.join(">") || "-"}`,
        );
        if (!result.pass) {
          console.log(
            [check.detail, ...rules.filter((rule) => rule.gate && !rule.pass).map((rule) => `${rule.name}: ${rule.detail}`)]
              .filter(Boolean)
              .flatMap((line) => line.split("\n"))
              .map((line) => `     ${line}`)
              .join("\n"),
          );
        }
      }
    }
  }

  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    const list = byTask.get(result.id) ?? [];
    list.push(result);
    byTask.set(result.id, list);
  }
  const aggregates: TaskAggregate[] = [...byTask.entries()].map(([id, list]) => {
    const passes = list.filter((result) => result.pass).length;
    return { id, attempts: list.length, passes, reward: passes / list.length, pass: passes > list.length / 2 };
  });

  const judged = results.filter((result) => result.judge);
  const metrics: RunMetrics = {
    passAt1: mean([...byTask.values()].map((list) => (list[0]?.pass ? 1 : 0))),
    passAtK: mean([...byTask.values()].map((list) => (list.some((result) => result.pass) ? 1 : 0))),
    passHatK: mean([...byTask.values()].map((list) => (list.every((result) => result.pass) ? 1 : 0))),
    majorityPass: aggregates.filter((aggregate) => aggregate.pass).length,
    meanReward: mean(aggregates.map((aggregate) => aggregate.reward)),
    promptTokens: results.reduce((sum, result) => sum + result.promptTokens, 0),
    completionTokens: results.reduce((sum, result) => sum + result.completionTokens, 0),
    judgePromptTokens: judged.reduce((sum, result) => sum + (result.judge?.usage?.promptTokens ?? 0), 0),
    judgeCompletionTokens: judged.reduce((sum, result) => sum + (result.judge?.usage?.completionTokens ?? 0), 0),
    judgeScored: judged.length,
    judgePassRate: judged.length > 0 ? judged.filter((result) => result.judge!.pass).length / judged.length : 0,
    judgeDisagreements: judged.filter((result) => result.judge!.pass !== result.pass).length,
    firstErrors: results.reduce<Record<string, number>>((counts, result) => {
      if (!result.firstError) return counts;
      counts[result.firstError] = (counts[result.firstError] ?? 0) + 1;
      return counts;
    }, {}),
  };

  const summary: RunSummary = {
    runId,
    model: settings.model,
    skill: options.skillPath ?? null,
    judgeModel: judgeSettings?.model ?? null,
    results,
    aggregates,
    metrics,
    passCount: aggregates.filter((aggregate) => aggregate.pass).length,
    total: aggregates.length,
    elapsedMs: Date.now() - started,
  };

  const summaryPath = jsonlPath.replace(/\.jsonl$/, `-${runId}.json`);
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const reportPath = resolve("data/eval-reports", `${runId}.md`);
  writeReport(summary, reportPath);
  summary.reportPath = reportPath;

  if (!options.quiet) {
    console.log("");
    for (const aggregate of aggregates) {
      console.log(
        `${aggregate.pass ? "PASS" : "FAIL"} ${aggregate.id}  ${aggregate.passes}/${aggregate.attempts}  reward=${aggregate.reward.toFixed(2)}`,
      );
    }
    console.log(
      `${describeModel(settings)} | skill=${options.skillPath ?? "-"} | judge=${judgeSettings?.model ?? "off"}`,
    );
    const k = Math.max(1, ...aggregates.map((aggregate) => aggregate.attempts));
    console.log(
      `pass@1=${(metrics.passAt1 * 100).toFixed(0)}%  ` +
        (k > 1 ? `pass@${k}=${(metrics.passAtK * 100).toFixed(0)}%  pass^${k}=${(metrics.passHatK * 100).toFixed(0)}%  ` : "") +
        `majority=${metrics.majorityPass}/${summary.total}`,
    );
    console.log(`tokens: agent ${metrics.promptTokens}in/${metrics.completionTokens}out, judge ${metrics.judgePromptTokens}in/${metrics.judgeCompletionTokens}out`);
    console.log(`report written to ${reportPath}`);
    console.log(`trajectories appended to ${jsonlPath}`);
    console.log(`summary written to ${summaryPath}`);
  }
  return summary;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
