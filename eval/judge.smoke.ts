import { judgeAttempt, readJudgeSettings } from "./judge.js";
import { DEFAULT_JUDGE_RUBRIC } from "./verifiers.js";

/**
 * One-shot judge smoke test: proves the endpoint, model name, and API key work
 * before spending an eval run on them.
 *
 * Usage: npm run eval:judge
 */

const settings = readJudgeSettings(process.env);
if (!settings) {
  console.error("JUDGE_API_KEY is not set. Add JUDGE_API_KEY / JUDGE_BASE_URL / JUDGE_MODEL to .env.");
  process.exit(1);
}

console.log(`judge: ${settings.model} at ${settings.baseUrl} (samples=${settings.samples})`);

const started = Date.now();
const result = await judgeAttempt(
  {
    taskId: "judge-smoke",
    title: "Add a clamp helper",
    prompt: "Add a clamp(value, min, max) helper to src/math.js and use it in src/page.js.",
    answer: "Added clamp to src/math.js and used it in src/page.js. The existing test still passes.",
    diff: [
      "--- a/src/math.js",
      "+++ b/src/math.js",
      "@@",
      "+export function clamp(value, min, max) {",
      "+  return Math.min(Math.max(value, min), max);",
      "+}",
      "--- a/src/page.js",
      "+++ b/src/page.js",
      "@@",
      "-  const width = Math.min(Math.max(raw, 0), 100);",
      "+  const width = clamp(raw, 0, 100);",
    ].join("\n"),
    checks: [{ name: "node --test", pass: true, output: "3 tests passed" }],
    rubric: DEFAULT_JUDGE_RUBRIC,
  },
  settings,
);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (!result.verdict) {
  console.error(`judge failed after ${elapsed}s: ${result.error ?? "unknown error"}`);
  process.exit(1);
}

console.log(`verdict in ${elapsed}s: pass=${result.verdict.pass} score=${result.verdict.score.toFixed(2)}`);
for (const criterion of result.verdict.criteria) {
  console.log(`  ${criterion.verdict.padEnd(7)} ${criterion.id}: ${criterion.note ?? ""}`);
}
console.log(`summary: ${result.verdict.summary}`);
if (result.verdict.invalidEvidence > 0) {
  console.log(`note: ${result.verdict.invalidEvidence} criterion verdict(s) lost their evidence and were discarded`);
}
