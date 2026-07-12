/**
 * Tests for director-budget.ts (AI Assistant Director Task 4): Anthropic
 * usage pricing and the budget-gate refusal helper. Both are pure
 * functions — no DB, no network.
 */
import { describe, it, expect } from "vitest";
import { usageCostUsd, assertWithinBudget, isBudgetExhausted } from "@/lib/director/director-budget";

describe("usageCostUsd", () => {
  it("prices anthropic usage", () => {
    expect(usageCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBe(3);
    expect(usageCostUsd({ input_tokens: 0, output_tokens: 100_000 })).toBe(1.5);
  });
});

describe("assertWithinBudget", () => {
  it("refuses over-budget spends with named numbers", () => {
    const r = assertWithinBudget(1.2, 1.5, 0.45);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toContain("1.2");
  });

  it("allows exact-fit spends", () => {
    expect(assertWithinBudget(1.0, 1.5, 0.5).ok).toBe(true);
  });
});

// Final-review finding I1: the direct-shot loop's hard budget stop reads
// this at the same boundaries it re-reads stopRequested.
describe("isBudgetExhausted", () => {
  it("is false while spend remains under budget", () => {
    expect(isBudgetExhausted(1.2, 1.5)).toBe(false);
  });

  it("is true at an exact-fit spend (budget can never be exceeded)", () => {
    expect(isBudgetExhausted(1.5, 1.5)).toBe(true);
  });

  it("is true once spend has overshot the budget", () => {
    expect(isBudgetExhausted(1.9, 1.5)).toBe(true);
  });
});
