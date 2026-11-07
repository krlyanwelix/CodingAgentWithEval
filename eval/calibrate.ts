import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectTasks } from "./tasks.js";
import { runEval, type RunSummary, type TaskResult } from "./runner.js";

/**
 * Judge calibration.
 *
 * The reference label is the objective stack (L0 assertion + gating rules);
 * the judge is only allowed into the pass gate once it agrees with that label
 * well enough (Cohen's kappa >= 0.70) on tasks whose quality it can assess.
 *
 * Usage: npm run eval:calibrate -- [--tasks all] [--repeat 1] [--out dir]
 */

interface Calibration {
  attempts: number;
  judged: number;
  errors: number;
  agreement: number;
  kappa: number;
  falseNegative: number;
  falsePositive: number;
  criteria: Record<string, { pass: number; fail: number; unclear: number }>;
}

export function calibrate(summary: RunSummary): Calibration {
  const judged = summary.results.filter((result) => result.judge);
  const criteria: Calibration["criteria"] = {};
  let agree = 0;
  let bothPass = 0;
  let bothFail = 0;
  let judgePass = 0;
  let goldPass = 0;
  let errors = 0;

  for (const result of summary.results) {
    if (!result.judge) {
      errors += 1;
      continue;
    }
    const gold = objectivePass(result);
    const verdict = result.judge.pass;
    if (gold === verdict) agree += 1;
    if (gold) goldPass += 1;
    if (verdict) judgePass += 1;
    if (gold && verdict) bothPass += 1;
    if (!gold && !verdict) bothFail += 1;
    for (const criterion of result.judge.criteria) {
      const bucket = (criteria[criterion.id] ??= { pass: 0, fail: 0, unclear: 0 });
      bucket[criterion.verdict] += 1;
    }
  }

  const n = judged.length;
  const observed = n === 0 ? 0 : agree / n;
  const expected =
    n === 0 ? 0 : (goldPass / n) * (judgePass / n) + (1 - goldPass / n) * (1 - judgePass / n);
  const kappa = expected === 1 ? 1 : (observed - expected) / (1 - expected);

  return {
    attempts: summary.results.length,
    judged: n,
    errors,
    agreement: observed,
    kappa: Number.isFinite(kappa) ? kappa : 0,
    falseNegative: judged.filter((result) => objectivePass(result) && !result.judge!.pass).length,
    falsePositive: judged.filter((result) => !objectivePass(result) && result.judge!.pass).length,
    criteria,
  };
}

function objectivePass(result: TaskResult): boolean {
  return result.l0 && result.rules.every((rule) => !rule.gate || rule.pass);
}

function render(summary: RunSummary, calibration: Calibration): string {
  const lines = [
    `# Judge calibration ${summary.runId}`,
    "",
    `- judge: \`${summary.judgeModel ?? "off"}\``,
    `- agent: \`${summary.model}\``,
    `- attempts: ${calibration.attempts}, judged: ${calibration.judged}, judge errors: ${calibration.errors}`,
    `- agreement with the objective stack: ${(calibration.agreement * 100).toFixed(1)}%`,
    `- Cohen's kappa: ${calibration.kappa.toFixed(3)} ${calibration.kappa >= 0.7 ? "(gate-safe)" : "(do NOT gate on the judge yet)"}`,
    `- false negatives (objective pass, judge fail): ${calibration.falseNegative}`,
    `- false positives (objective fail, judge pass): ${calibration.falsePositive}`,
    "",
    "## Per criterion",
    "",
    "| criterion | pass | fail | unclear |",
    "| --- | --- | --- | --- |",
    ...Object.entries(calibration.criteria).map(
      ([id, bucket]) => `| ${id} | ${bucket.pass} | ${bucket.fail} | ${bucket.unclear} |`,
    ),
    "",
  ];

  if (calibration.falseNegative + calibration.falsePositive > 0) {
    lines.push("## Disagreements", "");
    for (const result of summary.results) {
      if (!result.judge) continue;
      const gold = objectivePass(result);
      if (gold === result.judge.pass) continue;
      lines.push(
        `- \`${result.id}\`: objective=${gold ? "pass" : "fail"}, judge=${result.judge.pass ? "pass" : "fail"} (${result.judge.score.toFixed(2)})`,
        `  - ${result.judge.summary}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## How to read this",
    "",
    "Kappa is computed against the objective stack, which is itself only a proxy for correctness.",
    "Use disagreements as rubric bugs first and model errors second: a judge that fails a task the",
    "assertions prove correct usually means the rubric is asking for something the task never required.",
    "",
  );
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    flags.set(body, value);
    index += 1;
  }

  const summary = await runEval({
    tasks: selectTasks(flags.get("tasks") ?? "all"),
    repeat: Math.max(1, Number.parseInt(flags.get("repeat") ?? "1", 10) || 1),
    ...(flags.has("max-turns") ? { maxTurns: Number.parseInt(flags.get("max-turns")!, 10) || 20 } : {}),
    ...(flags.has("jsonl") ? { jsonlPath: resolve(flags.get("jsonl")!) } : {}),
    judge: true,
  });

  const calibration = calibrate(summary);
  const outDir = resolve(flags.get("out") ?? "data/calibration");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, `${summary.runId}.json`);
  const mdPath = resolve(outDir, `${summary.runId}.md`);
  writeFileSync(jsonPath, `${JSON.stringify({ summary: { runId: summary.runId, judgeModel: summary.judgeModel }, calibration }, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, render(summary, calibration), "utf8");
  console.log(render(summary, calibration));
  console.log(`written to ${mdPath} and ${jsonPath}`);

  if (calibration.errors > 0) {
    console.error(`${calibration.errors} attempt(s) could not be judged; check JUDGE_* settings and the judge endpoint.`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
