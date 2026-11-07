import assert from "node:assert/strict";
import { test } from "node:test";
import { layersPass, rubricFor, runRules } from "./verifiers.js";
import type { EvalTask } from "./tasks.js";

const task: EvalTask = {
  id: "demo",
  title: "Demo",
  prompt: "fix it",
  seed: { "test/sum.test.js": "test()", "src/sum.js": "export const sum = (a, b) => a - b;" },
  check: () => ({ pass: true, detail: "ok" }),
};

const seed = task.seed ?? {};

test("tests-untouched gates when a seeded test file changes", () => {
  const rules = runRules({ task, seed, changed: ["test/sum.test.js"], answer: "done", diff: "+ x" });
  const rule = rules.find((entry) => entry.name === "tests-untouched");
  assert.equal(rule?.pass, false);
  assert.equal(rule?.gate, true);
  assert.equal(layersPass(true, rules), false);
});

test("tests-untouched passes when only source files change", () => {
  const rules = runRules({ task, seed, changed: ["src/sum.js"], answer: "done", diff: "+ x" });
  assert.equal(rules.find((entry) => entry.name === "tests-untouched")?.pass, true);
  assert.equal(layersPass(true, rules), true);
});

test("a task without seeded tests cannot fail the test rule", () => {
  const bare: EvalTask = { id: "bare", title: "Bare", prompt: "go", check: () => ({ pass: true, detail: "" }) };
  const rules = runRules({ task: bare, seed: {}, changed: ["a.js"], answer: "done", diff: "+x" });
  const rule = rules.find((entry) => entry.name === "tests-untouched");
  assert.equal(rule?.pass, true);
  assert.equal(rule?.gate, false);
});

test("no-secret-leak catches credentials in the diff", () => {
  const rules = runRules({
    task,
    seed,
    changed: ["src/sum.js"],
    answer: "done",
    diff: '+ const key = "sk-ws-abcdefghijklmnopqrstuvwx";',
  });
  const rule = rules.find((entry) => entry.name === "no-secret-leak");
  assert.equal(rule?.pass, false);
  assert.equal(layersPass(true, rules), false);
});

test("an empty answer cannot pass even when the code is right", () => {
  const rules = runRules({ task, seed, changed: ["src/sum.js"], answer: "   ", diff: "+x" });
  assert.equal(layersPass(true, rules), false);
});

test("L0 failure fails the attempt regardless of rules", () => {
  const rules = runRules({ task, seed, changed: ["src/sum.js"], answer: "done", diff: "+x" });
  assert.equal(layersPass(false, rules), false);
});

test("rubricFor returns a task rubric or the default", () => {
  assert.equal(rubricFor(task)[0]?.id, "addresses-task");
  assert.equal(rubricFor({ ...task, id: "refactor-extract" })[0]?.id, "behavior-preserved");
  const weights = rubricFor(task).reduce((sum, criterion) => sum + criterion.weight, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9, `rubric weights should sum to 1, got ${weights}`);
});
