import { test } from "node:test";
import assert from "node:assert/strict";
import { countChangedLines, parseProposal, validateProposal } from "./proposal.js";

const SKILL = ["# Skill", "", "## Rules", "- run the tests", "- read before edit"].join("\n");

test("identical documents have no changes", () => {
  assert.equal(countChangedLines(SKILL.split("\n"), SKILL.split("\n")), 0);
});

test("one replaced line counts as two changes", () => {
  const after = SKILL.replace("- run the tests", "- run the tests twice").split("\n");
  assert.equal(countChangedLines(SKILL.split("\n"), after), 2);
});

test("parseProposal accepts fenced JSON", () => {
  const payload = JSON.stringify({ content: "# S\n\n## A\n", rationale: "why" });
  const proposal = parseProposal("```json\n" + payload + "\n```");
  assert.equal(proposal.content.startsWith("# S"), true);
  assert.equal(proposal.rationale, "why");
});

test("parseProposal rejects replies without JSON", () => {
  assert.throws(() => parseProposal("no json here"), /did not return JSON/);
});

test("validateProposal enforces the text learning rate", () => {
  const candidate = ["# Skill", "", "## Rules", "- run each test twice", "- read before edit", "- never skip"].join("\n");
  const verdict = validateProposal(SKILL, candidate, 5);
  assert.equal(verdict.ok, true);

  const oversized = validateProposal(SKILL, candidate, 1);
  assert.equal(oversized.ok, false);
  assert.match(oversized.reason ?? "", /over the 1-line limit/);
});

test("validateProposal requires headings and a size cap", () => {
  assert.equal(validateProposal(SKILL, "plain text", 50).ok, false);
  const huge = `## Huge\n${Array.from({ length: 90 }, (_, index) => `line ${index}`).join("\n")}`;
  assert.equal(validateProposal(SKILL, huge, 1000).ok, false);
});
