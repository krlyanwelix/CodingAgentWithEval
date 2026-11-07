import type { Usage } from "../src/types.js";

/**
 * L2 of the verifier stack: an LLM judge.
 *
 * Rules that keep it honest:
 * - It only sees artifacts (task prompt, diff, check output, final answer). Never
 *   the transcript, never the model's reasoning: judging a model by its own
 *   narration rewards confident prose over working code.
 * - Every verdict must cite evidence that literally occurs in one of the
 *   artifacts. Missing or fabricated quotes are downgraded to "unclear", so a
 *   lazy judge cannot silently pass a broken patch.
 * - Several samples are taken and the per-criterion majority wins, because a
 *   single call is noisy and position/length bias is measurable.
 * - The judge scores; it does not gate unless the run explicitly opts in
 *   (`gateJudge`). Objective checks (L0/L1) remain the source of truth until
 *   the judge is calibrated against human labels (see eval/calibrate.ts).
 */

export interface JudgeCriterion {
  id: string;
  description: string;
  /** Relative weight in the final score. */
  weight: number;
  /** A failed "must" criterion fails the whole verdict. */
  must?: boolean;
}

export type EvidenceSource = "diff" | "answer" | "checks";

export interface JudgeEvidence {
  source: EvidenceSource;
  quote: string;
  file?: string;
}

export interface CriterionVerdict {
  id: string;
  verdict: "pass" | "fail" | "unclear";
  evidence?: JudgeEvidence;
  note?: string;
}

export interface JudgeVerdict {
  /** Majority of the samples, after evidence validation. */
  pass: boolean;
  score: number;
  criteria: CriterionVerdict[];
  summary: string;
  model: string;
  samples: number;
  invalidEvidence: number;
  usage?: Usage;
}

export interface JudgeSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  samples: number;
  temperature: number;
}

export interface JudgeInput {
  taskId: string;
  title: string;
  prompt: string;
  answer: string;
  diff: string;
  checks: Array<{ name: string; pass: boolean; output: string }>;
  rubric: JudgeCriterion[];
}

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.8-flash";

export function readJudgeSettings(env: NodeJS.ProcessEnv = process.env): JudgeSettings | undefined {
  const apiKey = env.JUDGE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const samples = Number.parseInt(env.JUDGE_SAMPLES ?? "", 10);
  return {
    baseUrl: (env.JUDGE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey,
    model: env.JUDGE_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number.parseInt(env.JUDGE_TIMEOUT_MS ?? "", 10) || 60_000,
    samples: Number.isFinite(samples) && samples > 0 ? Math.min(5, samples) : 3,
    temperature: 0,
  };
}

export function requireJudgeSettings(env: NodeJS.ProcessEnv = process.env): JudgeSettings {
  const settings = readJudgeSettings(env);
  if (!settings) throw new Error("Missing JUDGE_API_KEY: set it in .env to run the LLM judge.");
  return settings;
}

const SYSTEM_PROMPT = `You are a strict, evidence-based code review judge for an automated coding-agent evaluation.

You receive: the task prompt, the rubric criteria, the workspace diff, the objective check results, and the agent's final answer. You do NOT receive the agent's reasoning or conversation, and you must not speculate about them.

Rules:
- Judge only what the artifacts prove. If a criterion is not evidenced by the diff, the check output, or the answer, verdict it "unclear" - never "pass".
- Every criterion verdict MUST include evidence whose "quote" is copied verbatim from one of the artifacts (a diff line, a check output line, or a sentence of the answer). Do not paraphrase or merge lines.
- Evidence source must be one of: "diff", "answer", "checks".
- Passing tests do not excuse a change that the prompt did not ask for, and a large diff is not better than a small one.
- The final answer must match what the diff actually does; a claim that is contradicted by the diff is a "fail" for the answer-consistency criterion.

Respond with JSON only, no prose and no code fences:
{"criteria":[{"id":"<rubric id>","verdict":"pass|fail|unclear","evidence":{"source":"diff|answer|checks","quote":"<exact text>","file":"<path, optional>"},"note":"<short>"}],"summary":"<one sentence>"}`;

function renderRubric(rubric: JudgeCriterion[]): string {
  return rubric
    .map((criterion) => `- ${criterion.id} (weight ${criterion.weight}${criterion.must ? ", must" : ""}): ${criterion.description}`)
    .join("\n");
}

function renderChecks(checks: JudgeInput["checks"]): string {
  if (checks.length === 0) return "(no checks)";
  return checks
    .map((check) => `### ${check.name}: ${check.pass ? "PASS" : "FAIL"}\n${check.output.slice(0, 1500)}`)
    .join("\n\n");
}

/** One user message; artifacts are labeled so the model can cite the right source. */
export function buildJudgeMessages(input: JudgeInput): Array<{ role: "system" | "user"; content: string }> {
  const user = [
    `## Task id\n${input.taskId}\n\n## Task\n${input.title}\n\n${input.prompt}`,
    `## Rubric\n${renderRubric(input.rubric)}`,
    `## Diff\n${input.diff.trim() || "(no changes)"}`,
    `## Objective checks\n${renderChecks(input.checks)}`,
    `## Final answer\n${input.answer.trim() || "(empty)"}`,
  ].join("\n\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

interface RawVerdict {
  criteria?: Array<{
    id?: string;
    verdict?: string;
    evidence?: { source?: string; quote?: string; file?: string };
    note?: string;
  }>;
  summary?: string;
}

/** Providers wrap JSON in fences or prose; take the outermost object. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A quote only counts if it literally occurs in the artifact it claims. */
export function evidenceIsValid(evidence: JudgeEvidence | undefined, input: JudgeInput): boolean {
  if (!evidence || typeof evidence.quote !== "string") return false;
  const quote = normalize(evidence.quote);
  if (quote.length < 6) return false;
  if (evidence.source !== "diff" && evidence.source !== "answer" && evidence.source !== "checks") return false;
  const haystack =
    evidence.source === "diff"
      ? normalize(input.diff)
      : evidence.source === "answer"
        ? normalize(input.answer)
        : normalize(input.checks.map((check) => `${check.name} ${check.pass ? "PASS" : "FAIL"} ${check.output}`).join("\n"));
  return haystack.includes(quote);
}

export interface JudgeRunResult {
  verdict: JudgeVerdict | undefined;
  error?: string;
}

/**
 * Ask the judge `samples` times, validate evidence in every sample, and merge by
 * per-criterion majority. Judge failures never fail an eval attempt: they are
 * reported as `error` and the objective verdict stands.
 */
export async function judgeAttempt(
  input: JudgeInput,
  settings: JudgeSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<JudgeRunResult> {
  const messages = buildJudgeMessages(input);
  // Samples are independent, so they go out together: three sequential 35s
  // calls would make the judge the slowest part of every eval attempt.
  const outcomes = await Promise.all(
    Array.from({ length: settings.samples }, () => requestSample(messages, settings, fetchImpl)),
  );
  const samples = outcomes.flatMap((outcome) => (outcome.sample ? [outcome.sample] : []));
  const usage = outcomes.reduce<Usage | undefined>((total, outcome) => addUsage(total, outcome.usage), undefined);
  const error = outcomes.find((outcome) => outcome.error)?.error;

  if (samples.length === 0) return { verdict: undefined, error: error ?? "judge produced no samples" };
  return { verdict: mergeSamples(samples, input, settings, usage), error };
}

interface SampleOutcome {
  sample?: RawVerdict;
  usage?: Usage;
  error?: string;
}

async function requestSample(
  messages: ReturnType<typeof buildJudgeMessages>,
  settings: JudgeSettings,
  fetchImpl: typeof fetch,
  attempt = 1,
): Promise<SampleOutcome> {
  try {
    const response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: settings.temperature,
        max_tokens: 900,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const usage: Usage | undefined =
      payload.usage && typeof payload.usage.prompt_tokens === "number"
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens ?? 0,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined;
    const parsed = extractJson(payload.choices?.[0]?.message?.content ?? "") as RawVerdict | undefined;
    if (!parsed || !Array.isArray(parsed.criteria)) throw new Error("judge returned no JSON criteria");
    return { sample: parsed, usage };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // One transient failure should not silently reduce the sample count.
    if (attempt < 2) return requestSample(messages, settings, fetchImpl, attempt + 1);
    return { error: message };
  }
}

function addUsage(total: Usage | undefined, extra: Usage | undefined): Usage | undefined {
  if (!extra) return total;
  if (!total) return extra;
  return {
    promptTokens: total.promptTokens + extra.promptTokens,
    completionTokens: total.completionTokens + extra.completionTokens,
    totalTokens: (total.totalTokens ?? 0) + (extra.totalTokens ?? 0),
  };
}

function mergeSamples(
  samples: RawVerdict[],
  input: JudgeInput,
  settings: JudgeSettings,
  usage: Usage | undefined,
): JudgeVerdict {
  let invalidEvidence = 0;
  const byCriterion = new Map<string, CriterionVerdict[]>();
  for (const sample of samples) {
    for (const raw of sample.criteria ?? []) {
      if (!raw?.id || !input.rubric.some((criterion) => criterion.id === raw.id)) continue;
      const verdict: CriterionVerdict["verdict"] =
        raw.verdict === "pass" || raw.verdict === "fail" ? raw.verdict : "unclear";
      const evidence: JudgeEvidence | undefined =
        raw.evidence && typeof raw.evidence.quote === "string"
          ? { source: raw.evidence.source as EvidenceSource, quote: raw.evidence.quote, file: raw.evidence.file }
          : undefined;
      let finalVerdict = verdict;
      if (finalVerdict !== "unclear" && !evidenceIsValid(evidence, input)) {
        // An unsupported "pass" is exactly how an unreliable judge rubber-stamps
        // broken work, so it loses its verdict instead of keeping a weak one.
        finalVerdict = "unclear";
        invalidEvidence += 1;
      }
      const list = byCriterion.get(raw.id) ?? [];
      list.push({ id: raw.id, verdict: finalVerdict, evidence, note: raw.note });
      byCriterion.set(raw.id, list);
    }
  }

  const criteria: CriterionVerdict[] = input.rubric.map((criterion) => {
    const votes = byCriterion.get(criterion.id) ?? [];
    const verdict = majority(votes.map((vote) => vote.verdict));
    const supporting = votes.find((vote) => vote.verdict === verdict);
    return {
      id: criterion.id,
      verdict,
      ...(supporting?.evidence ? { evidence: supporting.evidence } : {}),
      ...(supporting?.note ? { note: supporting.note } : {}),
    };
  });

  const totalWeight = input.rubric.reduce((sum, criterion) => sum + criterion.weight, 0) || 1;
  const score = criteria.reduce((sum, verdict) => {
    const criterion = input.rubric.find((item) => item.id === verdict.id)!;
    return sum + (verdict.verdict === "pass" ? criterion.weight : 0);
  }, 0) / totalWeight;
  const mustOk = criteria.every((verdict) => {
    const criterion = input.rubric.find((item) => item.id === verdict.id)!;
    return !criterion.must || verdict.verdict === "pass";
  });
  const pass = mustOk && score >= 0.75 && criteria.every((verdict) => verdict.verdict !== "unclear");

  return {
    pass,
    score: Number(score.toFixed(3)),
    criteria,
    summary: samples[0]?.summary ?? "",
    model: settings.model,
    samples: samples.length,
    invalidEvidence,
    ...(usage ? { usage } : {}),
  };
}

function majority(votes: Array<CriterionVerdict["verdict"]>): CriterionVerdict["verdict"] {
  const counts = new Map<CriterionVerdict["verdict"], number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  let best: CriterionVerdict["verdict"] = "unclear";
  let bestCount = 0;
  for (const [verdict, count] of counts) {
    if (count > bestCount) {
      best = verdict;
      bestCount = count;
    }
  }
  return best;
}
