/** Line-level diff size and proposal validation for the skill-evolution gate. */

export function countChangedLines(before: string[], after: string[]): number {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const common = table[0][0];
  return before.length + after.length - 2 * common;
}

export function parseProposal(text: string): { content: string; rationale: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The editor did not return JSON.");
  const parsed = JSON.parse(body.slice(start, end + 1)) as { content?: string; rationale?: string };
  if (typeof parsed.content !== "string" || parsed.content.trim().length === 0) {
    throw new Error("The editor returned no content.");
  }
  return { content: parsed.content, rationale: parsed.rationale ?? "" };
}

export interface ProposalCheck {
  ok: boolean;
  reason?: string;
}

/** "Text learning rate": a candidate may only change a few lines and must stay structured. */
export function validateProposal(
  current: string,
  candidate: string,
  maxChangedLines: number,
): ProposalCheck {
  const changed = countChangedLines(current.split("\n"), candidate.split("\n"));
  if (changed > maxChangedLines) {
    return { ok: false, reason: `change is ${changed} lines, over the ${maxChangedLines}-line limit` };
  }
  if (!candidate.includes("## ")) return { ok: false, reason: "candidate has no section headings" };
  if (candidate.split("\n").length > 80) return { ok: false, reason: "candidate is longer than 80 lines" };
  return { ok: true };
}
