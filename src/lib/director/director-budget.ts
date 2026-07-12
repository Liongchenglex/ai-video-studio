/**
 * AI Assistant Director budget metering. Prices Anthropic message usage
 * into USD (Sonnet rate card — estimates, kept in one place so the loop
 * and the tool executor agree) and gates spends against a run's budget.
 * Pure functions: no DB, no network. Used by direct-shot.ts (Anthropic
 * usage → spend) and director-tools.ts (per-tool budget checks before a
 * paid execute runs).
 */

/** Sonnet input-token rate, USD per million tokens. */
export const ANTHROPIC_USD_PER_MTOK_INPUT = 3;

/** Sonnet output-token rate, USD per million tokens. */
export const ANTHROPIC_USD_PER_MTOK_OUTPUT = 15;

/**
 * Prices one Anthropic messages.create usage block into USD, rounded to
 * 4 decimal places (fine enough to track cents-level spend without float
 * noise accumulating across many small calls in a run).
 */
export function usageCostUsd(u: { input_tokens: number; output_tokens: number }): number {
  const usd =
    (u.input_tokens / 1_000_000) * ANTHROPIC_USD_PER_MTOK_INPUT +
    (u.output_tokens / 1_000_000) * ANTHROPIC_USD_PER_MTOK_OUTPUT;
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * Gates a prospective spend against the run's remaining budget. Refuses
 * when spentUsd + estUsd exceeds budgetUsd; exact-fit spends (spent + est
 * === budget) are allowed. The refusal text names the concrete numbers so
 * it can be surfaced verbatim as a tool result / feed event.
 */
export function assertWithinBudget(
  spentUsd: number,
  budgetUsd: number,
  estUsd: number,
): { ok: true } | { ok: false; refusal: string } {
  const projected = spentUsd + estUsd;
  if (projected > budgetUsd) {
    return {
      ok: false,
      refusal: `Over budget: $${spentUsd.toFixed(2)} spent + $${estUsd.toFixed(2)} estimated would exceed the $${budgetUsd.toFixed(2)} budget.`,
    };
  }
  return { ok: true };
}

/**
 * True when a run's metered spend has reached (or exceeded) its budget —
 * the hard-stop boundary check the direct-shot loop applies at the same
 * points it re-reads `stopRequested` (final-review finding I1: "Budget can
 * never be exceeded" is a hard guarantee, but per-tool budget refusals
 * alone don't stop a run from burning free tool calls / Claude tokens for
 * the rest of its iterations once the budget is gone). Exact-fit
 * (spentUsd === budgetUsd) counts as exhausted: assertWithinBudget already
 * allows the spend that lands exactly on budget, so the boundary check
 * right after that spend is what stops any further iteration.
 */
export function isBudgetExhausted(spentUsd: number, budgetUsd: number): boolean {
  return spentUsd >= budgetUsd;
}
