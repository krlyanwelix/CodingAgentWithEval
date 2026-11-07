import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_JUDGE_RUBRIC } from "./verifiers.js";
import { evidenceIsValid, judgeAttempt, type JudgeInput, type JudgeSettings } from "./judge.js";

const input: JudgeInput = {
  taskId: "demo",
  title: "Clamp",
  prompt: "Add clamp and use it.",
  answer: "Added clamp and used it in page.js.",
  diff: [
    "--- a/src/math.js",
    "+++ b/src/math.js",
    "+export function clamp(value, min, max) {",
    "+  return Math.min(Math.max(value, min), max);",
    "+}",
  ].join("\n"),
  checks: [{ name: "node --test", pass: true, output: "3 tests passed" }],
  rubric: DEFAULT_JUDGE_RUBRIC,
};

const settings: JudgeSettings = {
  baseUrl: "http://judge.test/v1",
  apiKey: "test-key",
  model: "test-judge",
  timeoutMs: 5000,
  samples: 3,
  temperature: 0,
};

function verdictFor(verdict: "pass" | "fail", quote = "export function clamp"): string {
  return JSON.stringify({
    pass: verdict === "pass",
    score: verdict === "pass" ? 1 : 0,
    summary: "stub",
    criteria: DEFAULT_JUDGE_RUBRIC.map((criterion) => ({
      id: criterion.id,
      verdict,
      evidence: { source: "diff", quote },
      note: "stub",
    })),
  });
}

function fakeFetch(content: string): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }) as unknown as Response) as typeof fetch;
}

test("evidence must be locatable in the artifacts", () => {
  assert.equal(evidenceIsValid({ source: "diff", quote: "export function clamp" }, input), true);
  assert.equal(evidenceIsValid({ source: "diff", quote: "this text is not in the diff" }, input), false);
  assert.equal(evidenceIsValid({ source: "answer", quote: "used it in page.js" }, input), true);
  assert.equal(evidenceIsValid(undefined, input), false);
});

test("unanimous supported verdicts pass", async () => {
  const result = await judgeAttempt(input, settings, fakeFetch(verdictFor("pass")));
  assert.ok(result.verdict);
  assert.equal(result.verdict.pass, true);
  assert.ok(result.verdict.score >= 0.75);
  assert.equal(result.verdict.samples, 3);
  assert.equal(result.verdict.invalidEvidence, 0);
  assert.equal(result.verdict.usage?.promptTokens, 30);
});

test("a pass without locatable evidence is discarded, not trusted", async () => {
  const result = await judgeAttempt(input, settings, fakeFetch(verdictFor("pass", "totally made up quote")));
  assert.ok(result.verdict);
  assert.equal(result.verdict.pass, false);
  assert.ok(result.verdict.invalidEvidence > 0);
  assert.ok(result.verdict.criteria.every((criterion) => criterion.verdict === "unclear"));
});

test("a failed sample is retried instead of shrinking the sample set", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("socket hang up");
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: verdictFor("pass") } }] }),
    };
  }) as unknown as typeof fetch;
  const result = await judgeAttempt(input, { ...settings, samples: 1 }, flaky);
  assert.ok(result.verdict);
  assert.equal(result.verdict.pass, true);
  assert.equal(calls, 2);
});

test("a judge that never answers returns an error, not a fail", async () => {
  const broken = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const result = await judgeAttempt(input, { ...settings, samples: 2 }, broken);
  assert.equal(result.verdict, undefined);
  assert.match(result.error ?? "", /connection refused/);
});
