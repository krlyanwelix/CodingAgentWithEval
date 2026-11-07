import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunSummary, TaskResult } from "./runner.js";

/** Human-readable run report: what ran, what passed, and why the rest failed. */
export function writeReport(summary: RunSummary, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderReport(summary), "utf8");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function renderReport(summary: RunSummary): string {
  const { metrics, results, aggregates } = summary;
  const attempts = results.length;
  const lines: string[] = [];

  lines.push(`# Eval run ${summary.runId}`, "");
  lines.push(
    `- model: \`${summary.model}\``,
    `- judge: \`${summary.judgeModel ?? "off"}\``,
    `- skill: \`${summary.skill ?? "-"}\``,
    `- tasks: ${summary.total}, attempts: ${attempts}, wall clock: ${(summary.elapsedMs / 1000).toFixed(1)}s`,
    `- tokens: agent ${metrics.promptTokens} in / ${metrics.completionTokens} out; judge ${metrics.judgePromptTokens} in / ${metrics.judgeCompletionTokens} out`,
    "",
  );

  lines.push("## Headline", "");
  lines.push("| metric | value | meaning |", "| --- | --- | --- |");
  lines.push(`| Pass@1 | ${pct(metrics.passAt1)} | first attempt of every task |`);
  lines.push(`| Pass@k | ${pct(metrics.passAtK)} | any attempt passes, k=${attempts / Math.max(1, summary.total)} |`);
  lines.push(`| Pass^k | ${pct(metrics.passHatK)} | every attempt passes: reliability |`);
  lines.push(`| Majority | ${metrics.majorityPass}/${summary.total} | >half of attempts pass |`);
  lines.push(`| Mean reward | ${metrics.meanReward.toFixed(2)} | fraction of attempts passing, averaged |`);
  if (metrics.judgeScored > 0) {
    lines.push(
      `| Judge pass rate | ${pct(metrics.judgePassRate)} | across ${metrics.judgeScored} judged attempts |`,
      `| Judge/objective disagreements | ${metrics.judgeDisagreements} | investigate before gating on the judge |`,
    );
  }
  lines.push("");

  lines.push("## Per task", "");
  lines.push("| task | pass | reward | L0 | judge | first error | steps |", "| --- | --- | --- | --- | --- | --- | --- |");
  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    const list = byTask.get(result.id) ?? [];
    list.push(result);
    byTask.set(result.id, list);
  }
  for (const aggregate of aggregates) {
    const list = byTask.get(aggregate.id) ?? [];
    const l0 = list.filter((result) => result.l0).length;
    const judged = list.filter((result) => result.judge);
    const judgeMean = judged.length === 0 ? 0 : judged.reduce((sum, result) => sum + result.judge!.score, 0) / judged.length;
    const judgeCell =
      judged.length === 0
        ? "-"
        : `${judged.filter((result) => result.judge!.pass).length}/${judged.length} (${judgeMean.toFixed(2)})`;
    const errors = [...new Set(list.map((result) => result.firstError).filter(Boolean))];
    const steps = Math.round(list.reduce((sum, result) => sum + result.steps, 0) / Math.max(1, list.length));
    lines.push(
      `| ${aggregate.id} | ${aggregate.passes}/${aggregate.attempts} | ${aggregate.reward.toFixed(2)} | ${l0}/${list.length} | ${judgeCell} | ${errors.join(", ") || "-"} | ${steps} |`,
    );
  }
  lines.push("");

  const failures = results.filter((result) => !result.pass);
  if (failures.length > 0) {
    lines.push("## Failures", "");
    for (const result of failures) {
      lines.push(`### ${result.id}`, "");
      if (result.firstError) lines.push(`- attributed to: \`${result.firstError}\``);
      lines.push(`- L0: ${result.l0 ? "pass" : "fail"} — ${result.detail}`);
      for (const rule of result.rules.filter((rule) => rule.gate && !rule.pass)) {
        lines.push(`- rule \`${rule.name}\`: ${rule.detail}`);
      }
      if (result.judgeError) lines.push(`- judge error: ${result.judgeError}`);
      if (result.judge && !result.judge.pass) {
        lines.push(`- judge: ${result.judge.summary}`);
        for (const criterion of result.judge.criteria.filter((entry) => entry.verdict !== "pass")) {
          lines.push(`  - \`${criterion.id}\` ${criterion.verdict}: ${criterion.note ?? "(no note)"}`);
        }
      }
      if (result.answerPreview) lines.push("", "```", result.answerPreview.trim(), "```");
      lines.push("");
    }
  }

  if (Object.keys(metrics.firstErrors).length > 0) {
    lines.push("## First-error attribution", "", "| bucket | attempts |", "| --- | --- |");
    for (const [bucket, count] of Object.entries(metrics.firstErrors).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${bucket} | ${count} |`);
    }
    lines.push("");
    lines.push(
      "`harness:*` and `provider` buckets mean the run failed for reasons the model could not fix; " +
        "`model:*` means the agent had the information and still did not solve it.",
      "",
    );
  }

  return lines.join("\n");
}
