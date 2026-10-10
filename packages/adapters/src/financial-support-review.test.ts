import type { AdapterContext, AutoReviewProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { reviewTradingSupport } from "./financial-support-review.js";

const context = {
  operationId: "fixture",
  userId: "owner",
  botId: "Gold",
  signal: new AbortController().signal,
} as AdapterContext;
const base = {
  toolName: "shell",
  args: { command: "generate report" },
  userTask: "Research gold",
  context,
  knownSecrets: [],
};
function provider(review: AutoReviewProvider["review"]) {
  return { review } as AutoReviewProvider;
}
describe("mandatory trading support review", () => {
  it("permits ordinary Computer work only after independent pass", async () => {
    const review = vi.fn(async () => ({ decision: "pass" as const, model: "fixture" }));
    expect(await reviewTradingSupport({ ...base, provider: provider(review) })).toBe(true);
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ connectorKind: "trading_support", matchingRules: [] }),
      expect.anything(),
    );
  });
  it.each(["deny", "ask", "error"] as const)(
    "blocks bypass or uncertain work on %s",
    async (decision) => {
      expect(
        await reviewTradingSupport({
          ...base,
          args: { command: "broker order mutation" },
          provider: provider(async () => ({ decision, model: "fixture" })),
        }),
      ).toBe(false);
    },
  );
  it("blocks when review is unavailable or throws", async () => {
    expect(await reviewTradingSupport(base)).toBe(false);
    expect(
      await reviewTradingSupport({
        ...base,
        provider: provider(async () => {
          throw new Error("Unavailable");
        }),
      }),
    ).toBe(false);
  });
  it("bounds an adapter that ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const result = reviewTradingSupport({
        ...base,
        provider: provider(() => new Promise(() => {})),
      });
      await vi.advanceTimersByTimeAsync(1501);
      expect(await result).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("redacts credentials before independent review", async () => {
    const review = vi.fn(async () => ({ decision: "deny" as const, model: "fixture" }));
    await reviewTradingSupport({
      ...base,
      args: { password: "fixture-sensitive" },
      knownSecrets: ["fixture-sensitive"],
      provider: provider(review),
    });
    expect(JSON.stringify(review.mock.calls)).not.toContain("fixture-sensitive");
  });
});
