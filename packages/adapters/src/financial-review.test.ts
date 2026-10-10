import type { AdapterContext, AutoReviewProvider, AutoReviewResult } from "@rakazo/adapter-kit";
import type { FinancialReviewContext } from "@rakazo/contracts";
import {
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutoReviewPrompt } from "./auto-review.js";
import { reviewFinancialAction } from "./financial-review.js";

const now = new Date("2026-10-09T10:00:00Z");
const base: FinancialReviewContext = {
  version: 1,
  policyVersion: "financial-v1",
  mandateId: "mandate",
  planVersion: 2,
  action: {
    version: 1,
    mode: "SIMULATION",
    provider: "metaapi",
    accountId: "account",
    instrumentId: "gold",
    brokerSymbol: "GOLD.a",
    operation: "OPEN",
    side: "BUY",
    orderType: "MARKET",
    volume: "0.01",
    price: null,
    stopLimitPrice: null,
    expiresAt: null,
    fillingMode: null,
    stopLoss: "2695",
    takeProfit: "2710",
  },
  envelope: {
    version: 1,
    ownerId: "owner",
    botId: "main",
    accountId: "account",
    mode: "SIMULATION",
    expiresAt: "2026-10-10T10:00:00Z",
    allowedInstruments: ["gold"],
    allowedOperations: ["OPEN"],
    maxMissionLoss: "100",
    maxOpenRisk: "40",
    maxRiskPerTrade: "20",
    maxConcurrentPositions: 2,
    maxPendingOrders: 2,
    breachBehavior: "FREEZE",
    expiryBehavior: "FREEZE",
    targetBehavior: "FREEZE",
    currency: "USD",
    allocatedCapital: "2000",
    maxNotional: "10000",
    maxMarginUsagePercent: "50",
    maxDailyLoss: null,
    allowedOrderTypes: ["MARKET", "LIMIT"],
    riskIncreasePermissions: [],
    supervisionPositionId: null,
    supervisedOrderIds: [],
    riskCalculationVersion: "stop-loss-v1",
    costReservePerTrade: "1",
  },
  actionFingerprint: "",
  mandateFingerprint: "",
  observedAt: now.toISOString(),
  risk: {
    decision: "ALLOW",
    calculationVersion: "stop-loss-v1",
    riskBefore: "0",
    riskAfter: "6.1",
    incrementalRisk: "6.1",
    notional: "2700.1",
    margin: "30",
    classification: "INCREASES_RISK",
  },
  rationaleSummary: "A bounded proposed action, not a promised return.",
  evidenceRefs: [],
  chartRefs: [],
};
base.actionFingerprint = financialActionFingerprint(base.action);
base.mandateFingerprint = tradingMandateFingerprint(base.envelope);
const context: AdapterContext = {
  operationId: "fixture",
  traceId: "fixture",
  spaceId: "space",
  userId: "owner",
  botId: "main",
  signal: new AbortController().signal,
};
function provider(result: AutoReviewResult): AutoReviewProvider {
  return {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { offline: true },
    }),
    review: vi.fn(async () => result),
  };
}
afterEach(() => vi.useRealTimers());
describe("independent financial Auto Review", () => {
  it.each(["pass", "ask", "deny"] as const)(
    "preserves a valid independent %s decision",
    async (decision) => {
      const reviewer = provider({ decision, model: "fixture", reason: "Concise result" });
      expect(
        await reviewFinancialAction({ financial: base, provider: reviewer, context, now }),
      ).toMatchObject({ decision, model: "fixture" });
      expect(reviewer.review).toHaveBeenCalledWith(
        expect.objectContaining({ financial: base, matchingRules: [] }),
        expect.objectContaining({ operationId: "financial-review:fixture" }),
      );
    },
  );
  it("independently reviews only exact expiry finishing reductions under unchanged fingerprints", async () => {
    const at = new Date("2026-10-10T10:01:00Z");
    const finishing: FinancialReviewContext = {
      ...base,
      action: {
        version: 1,
        mode: "SIMULATION",
        provider: "metaapi",
        accountId: "account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "CANCEL_ORDER",
        orderId: "exact-order",
      },
      envelope: {
        ...base.envelope,
        allowedOperations: ["CANCEL_ORDER", "OPEN"],
        expiryBehavior: "CANCEL_PENDING",
      },
      mandateState: {
        status: "EXPIRED",
        startsAt: now.toISOString(),
        endsAt: base.envelope.expiresAt,
      },
      observedAt: at.toISOString(),
      risk: {
        decision: "ALLOW",
        calculationVersion: "stop-loss-v1",
        riskBefore: "6.1",
        riskAfter: "0",
        incrementalRisk: "0",
        notional: "0",
        margin: "0",
        classification: "REDUCES_RISK",
      },
    };
    finishing.actionFingerprint = financialActionFingerprint(finishing.action);
    finishing.mandateFingerprint = tradingMandateFingerprint(finishing.envelope);
    const reviewer = provider({ decision: "pass", model: "fixture" });
    expect(
      await reviewFinancialAction({ financial: finishing, provider: reviewer, context, now: at }),
    ).toMatchObject({ decision: "pass" });
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    const opening = {
      ...finishing,
      action: base.action,
      actionFingerprint: base.actionFingerprint,
    };
    expect(
      await reviewFinancialAction({ financial: opening, provider: reviewer, context, now: at }),
    ).toMatchObject({ decision: "deny" });
    expect(
      await reviewFinancialAction({
        financial: {
          ...finishing,
          mandateState: { ...finishing.mandateState!, status: "CANCELLED" },
        },
        provider: reviewer,
        context,
        now: at,
      }),
    ).toMatchObject({ decision: "deny" });
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });
  it("cannot override deterministic risk denial", async () => {
    const reviewer = provider({ decision: "pass", model: "fixture" });
    expect(
      await reviewFinancialAction({
        financial: { ...base, risk: { decision: "DENY", code: "MISSION_LOSS_LIMIT" } },
        provider: reviewer,
        context,
        now,
      }),
    ).toMatchObject({ decision: "deny", model: "deterministic" });
    expect(reviewer.review).not.toHaveBeenCalled();
  });
  it.each(["actionFingerprint", "mandateFingerprint"] as const)(
    "refuses changed %s before model review",
    async (key) => {
      const reviewer = provider({ decision: "pass", model: "fixture" });
      expect(
        await reviewFinancialAction({
          financial: { ...base, [key]: "0".repeat(64) },
          provider: reviewer,
          context,
          now,
        }),
      ).toMatchObject({ decision: "deny" });
      expect(reviewer.review).not.toHaveBeenCalled();
    },
  );
  it("binds the acting owner/Bot and exact account, without inheriting peer authority", async () => {
    for (const actor of [
      { ...context, botId: "peer" },
      { ...context, userId: "other" },
    ])
      expect(
        await reviewFinancialAction({
          financial: base,
          provider: provider({ decision: "pass", model: "fixture" }),
          context: actor,
          now,
        }),
      ).toMatchObject({ decision: "deny" });
    const financial = { ...base, action: { ...base.action, accountId: "other" } };
    financial.actionFingerprint = financialActionFingerprint(financial.action);
    expect(await reviewFinancialAction({ financial, context, now })).toMatchObject({
      decision: "deny",
    });
  });
  it("fails safely when no reviewer is available or the reviewer errors", async () => {
    expect(await reviewFinancialAction({ financial: base, context, now })).toMatchObject({
      decision: "ask",
    });
    const reviewer = provider({ decision: "error", model: "fixture" });
    expect(
      await reviewFinancialAction({ financial: base, context, provider: reviewer, now }),
    ).toMatchObject({ decision: "ask" });
    reviewer.review = vi.fn(async () => {
      throw new Error("Untrusted provider diagnostic");
    });
    expect(
      await reviewFinancialAction({ financial: base, context, provider: reviewer, now }),
    ).toMatchObject({ decision: "ask" });
  });
  it("bounds an uncooperative reviewer that ignores abort", async () => {
    vi.useFakeTimers();
    const reviewer = provider({ decision: "pass", model: "fixture" });
    reviewer.review = vi.fn(async () => new Promise<AutoReviewResult>(() => {}));
    const pending = reviewFinancialAction({
      financial: base,
      provider: reviewer,
      context,
      now,
      timeoutMs: 200,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ decision: "ask" });
  });
  it("cancellation does not become a persisted reviewer decision", async () => {
    const controller = new AbortController();
    const reviewer = provider({ decision: "pass", model: "fixture" });
    reviewer.review = vi.fn(async (): Promise<AutoReviewResult> => {
      controller.abort();
      return { decision: "pass", model: "fixture" };
    });
    await expect(
      reviewFinancialAction({
        financial: base,
        context: { ...context, signal: controller.signal },
        provider: reviewer,
        now,
      }),
    ).rejects.toThrow();
  });
  it("redacts sentinel secrets from input, reason and model label", async () => {
    const sentinel = "FIXTURE_SECRET_DO_NOT_DISCLOSE";
    const reviewer = provider({ decision: "pass", model: `fixture/${sentinel}`, reason: sentinel });
    const result = await reviewFinancialAction({
      financial: { ...base, rationaleSummary: `Sensitive ${sentinel}` },
      provider: reviewer,
      context,
      now,
      knownSecrets: [sentinel],
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(vi.mocked(reviewer.review).mock.calls)).not.toContain(sentinel);
  });
  it("renders the complete validated financial envelope as data rather than truncating authorization", () => {
    const prompt = buildAutoReviewPrompt({
      toolName: "trade_execute",
      connectorKind: "financial",
      args: {},
      userTask: "Review",
      botDescription: "Main",
      matchingRules: [],
      financial: base,
    });
    expect(prompt).toContain('"maxMissionLoss":"100"');
    expect(prompt).toContain('"planVersion":2');
    expect(prompt).toContain("cannot enlarge financial authority");
    expect(prompt).toContain("<financial_context>");
  });
  it("does not review expired authority or stale account evidence", async () => {
    const reviewer = provider({ decision: "pass", model: "fixture" });
    expect(
      await reviewFinancialAction({
        financial: base,
        context,
        provider: reviewer,
        now: new Date("2026-10-11T10:00:00Z"),
      }),
    ).toMatchObject({ decision: "deny" });
    expect(
      await reviewFinancialAction({
        financial: { ...base, observedAt: "2026-10-09T09:00:00Z" },
        context,
        provider: reviewer,
        now,
      }),
    ).toMatchObject({ decision: "deny" });
    expect(reviewer.review).not.toHaveBeenCalled();
  });
});
