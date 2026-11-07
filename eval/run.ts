import { resolve } from "node:path";
import { selectTasks } from "./tasks.js";
import { runEval, type RunMetrics, type RunSummary, type TaskAggregate, type TaskResult } from "./runner.js";

export { runEval } from "./runner.js";
export type { RunMetrics, RunSummary, TaskAggregate, TaskResult } from "./runner.js";

/**
 * CLI entry point. The runner owns the loop; this file only parses flags and
 * sets the exit code, so `npm run eval` and `npm run evolve` share one code path.
 */

function usage(): never {
  console.log(
    [
      "Usage: npm run eval -- [options]",
      "",
      "  --tasks <spec>      all | holdout | comma separated ids (default: all, holdout excluded)",
      "  --skill <path>      prepend a skill document to the system prompt",
      "  --repeat <n>        attempts per task (default: 1; use 3-5 for Pass^k)",
      "  --jsonl <path>      append trajectories here (default: data/trajectories.jsonl)",
      "  --max-turns <n>     agent turn cap per attempt (default: 20)",
      "  --judge             fail if JUDGE_API_KEY is missing (default: judge when the key exists)",
      "  --no-judge          disable the L2 judge for this run",
      "  --judge-samples <n> judge samples per attempt, 1-5 (default: 3)",
      "  --gate-judge        make the judge part of pass/fail (only after calibration)",
      "  --quiet             only print the final table",
    ].join("\n"),
  );
  process.exit(2);
}

function numberFlag(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(argv: string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) usage();
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const name = body;
    if (name === "help") usage();
    if (name === "quiet" || name === "judge" || name === "no-judge" || name === "gate-judge") {
      flags.set(name, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage();
    flags.set(name, value);
    index += 1;
  }

  const tasks = selectTasks(flags.get("tasks") ?? "all");
  const summary: RunSummary = await runEval({
    tasks,
    ...(flags.has("skill") ? { skillPath: resolve(flags.get("skill")!) } : {}),
    repeat: numberFlag(flags.get("repeat"), 1),
    ...(flags.has("jsonl") ? { jsonlPath: resolve(flags.get("jsonl")!) } : {}),
    ...(flags.has("max-turns") ? { maxTurns: numberFlag(flags.get("max-turns"), 20) } : {}),
    ...(flags.has("quiet") ? { quiet: true } : {}),
    ...(flags.has("no-judge") ? { judge: false } : {}),
    ...(flags.has("judge") ? { judge: true } : {}),
    ...(flags.has("judge-samples") ? { judgeSamples: numberFlag(flags.get("judge-samples"), 3) } : {}),
    ...(flags.has("gate-judge") ? { gateJudge: true } : {}),
  });

  process.exitCode = summary.passCount === summary.total ? 0 : 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
