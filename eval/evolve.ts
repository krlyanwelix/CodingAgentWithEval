import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createModel } from "../src/model-config.js";
import type { Message } from "../src/types.js";
import { runEval, type RunSummary } from "./run.js";
import { countChangedLines, parseProposal, validateProposal } from "./proposal.js";
import { selectTasks } from "./tasks.js";

const MAX_CHANGED_LINES = 15;

const EDITOR_PROMPT = `You maintain a coding skill document (Markdown) for a small language model that acts as a coding agent.
You will be shown the current skill, the prompts of failed eval tasks, and what the agent did on each one.
Rewrite the skill so the next attempt succeeds. Rules:
- Keep the document short: at most 60 lines. Never exceed the current line count by more than ${MAX_CHANGED_LINES} lines.
- Only edit the skill. Do not invent eval results or claim tests passed.
- Prefer concrete, checkable rules (what to run, what to read back, what to avoid) over motivation.
- Return strict JSON: {"content": "<full new skill markdown>", "rationale": "<one sentence>"} and nothing else.`;

function transcript(summary: RunSummary): string {
  return summary.results
    .filter((result) => !result.pass)
    .map((result) => {
      const task = selectTasks("all").find((item) => item.id === result.id);
      return [
        `## Task ${result.id}: ${result.title}`,
        `Prompt: ${task?.prompt ?? ""}`,
        `Check: ${result.detail.split("\n")[0]}`,
        `Tools used: ${result.toolCalls.join(" > ") || "none"}`,
        `Steps: ${result.steps}`,
        `Warnings: ${result.warnings.join(" | ") || "none"}`,
        `Final answer: ${result.answerPreview || "(empty)"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function args(): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    parsed.set(key, rest.join("=") || "true");
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = args();
  const skillPath = resolve(options.get("skill") ?? "skills/coding-guide/SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`No skill at ${skillPath}`);
  const taskSpec = options.get("tasks") ?? "all";
  const tasks = selectTasks(taskSpec);
  const current = readFileSync(skillPath, "utf8");

  console.log(`## Baseline (${tasks.length} tasks, skill=${skillPath})`);
  const baseline = await runEval({ tasks, skillPath });

  if (baseline.passCount === baseline.total) {
    console.log("All tasks already pass; nothing to evolve.");
    return;
  }

  const { model, settings } = createModel(process.env);
  const proposalText = await model.complete(
    [
      { role: "system", content: EDITOR_PROMPT },
      {
        role: "user",
        content: `# Current skill\n\n${current}\n\n# Baseline score\n\n${baseline.passCount}/${baseline.total} passed.\n\n# Failed tasks\n\n${transcript(baseline)}`,
      } as Message,
    ],
    [],
  );

  const proposal = parseProposal(proposalText.content ?? "");
  const changed = countChangedLines(current.split("\n"), proposal.content.split("\n"));
  console.log(`\n## Proposal (${settings.model})\nchanged lines: ${changed}\nrationale: ${proposal.rationale}`);
  const verdict = validateProposal(current, proposal.content, MAX_CHANGED_LINES);
  if (!verdict.ok) {
    console.log(`Rejected: ${verdict.reason}.`);
    return;
  }

  const candidatePath = resolve(dirname(skillPath), "SKILL.candidate.md");
  writeFileSync(candidatePath, proposal.content);

  console.log(`\n## Candidate (verification on the ${baseline.total - baseline.passCount} failed tasks)`);
  const failedIds = baseline.results.filter((result) => !result.pass).map((result) => result.id);
  const candidate = await runEval({ tasks: selectTasks(failedIds.join(",")), skillPath: candidatePath });

  const accepted = candidate.passCount === candidate.total;
  const historyPath = resolve(dirname(skillPath), "HISTORY.md");
  const line =
    `\n## ${new Date().toISOString()} ${accepted ? "accepted" : "rejected"}\n` +
    `- baseline: ${baseline.passCount}/${baseline.total}\n` +
    `- candidate: ${candidate.passCount}/${candidate.total} on ${failedIds.join(", ")}\n` +
    `- changed lines: ${changed}\n` +
    `- rationale: ${proposal.rationale}\n`;
  appendFileSync(historyPath, line, "utf8");

  if (accepted) {
    writeFileSync(skillPath, proposal.content);
    console.log(`Accepted: ${basename(skillPath)} updated. History: ${historyPath}`);
  } else {
    console.log(`Rejected: candidate did not fix every failing task. Kept ${candidatePath} for inspection.`);
    process.exitCode = 1;
  }
}

await main();


