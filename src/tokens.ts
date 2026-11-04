/**
 * Token budgeting for the model context.
 *
 * The agent never trusts a real tokenizer (it has none), so everything here is a
 * deliberate over-estimate: CJK characters cost ~1 token each and the rest ~3.6
 * characters per token, rounded up. Models break long before the budget says so,
 * which is the point — a conservative estimate makes compaction happen early
 * rather than after a 400 from the API.
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** Rough token count for a string (CJK ≈ 1 token/char, other text ≈ 3.6 chars/token). */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk++;
  }
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.9 + rest / 3.6));
}
