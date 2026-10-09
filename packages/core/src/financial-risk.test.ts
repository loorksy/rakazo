import type {
  FinancialAction,
  FinancialRiskFacts,
  FinancialRiskState,
  FinancialRiskTarget,
  TradingMandateEnvelope,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { financialCeil, financialDecimal, financialUnits } from "./financial-decimal.js";
import { assessFinancialAction } from "./financial-risk.js";
import { tradingMandateFingerprint } from "./node/financial-action.js";

const now = new Date("2026-10-09T10:00:00Z");
const envelope: TradingMandateEnvelope = {
  version: 1,
  ownerId: "owner",
  botId: "main",
  accountId: "account",
  mode: "SIMULATION",
  expiresAt: "2026-10-10T10:00:00Z",
  allowedInstruments: ["gold"],
  allowedOperations: [
    "OPEN",
    "MODIFY_PROTECTION",
    "CLOSE_POSITION",
    "MODIFY_ORDER",
    "CANCEL_ORDER",
  ],
  maxMissionLoss: "100",
  maxOpenRisk: "60",
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
  maxDailyLoss: "50",
  allowedOrderTypes: ["MARKET", "LIMIT", "STOP"],
  riskIncreasePermissions: [],
  supervisionPositionId: null,
  supervisedOrderIds: [],
  riskCalculationVersion: "stop-loss-v1",
  costReservePerTrade: "1",
};
const action: FinancialAction = {
  version: 1,
  mode: "SIMULATION",
  provider: "metaapi",
  accountId: "account",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  operation: "OPEN",
  side: "BUY",
  orderType: "MARKET",
  volume: "0.02",
  price: null,
  stopLimitPrice: null,
  expiresAt: null,
  fillingMode: null,
  stopLoss: "2695",
  takeProfit: "2710",
};
const facts: FinancialRiskFacts = {
  version: 1,
  accountId: "account",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  currency: "USD",
  connected: true,
  tradingAllowed: true,
  accountMode: "HEDGING",
  observedAt: now.toISOString(),
  equity: "10000",
  freeMargin: "9500",
  margin: "500",
  quote: {
    version: 1,
    provider: "metaapi",
    accountId: "account",
    instrumentId: "gold",
    brokerSymbol: "GOLD.a",
    bid: "2700",
    ask: "2700.1",
    sourceTime: now.toISOString(),
    receivedAt: now.toISOString(),
    revision: "q1",
  },
  tickSize: "0.01",
  lossTickValue: "1",
  contractSize: "100",
  profitCurrency: "USD",
  minVolume: "0.01",
  maxVolume: "100",
  volumeStep: "0.01",
  digits: 2,
  stopsLevel: 10,
  symbolTradingAllowed: true,
  specificationObservedAt: now.toISOString(),
  orderTypes: ["MARKET", "LIMIT", "STOP"],
  partialClose: true,
  proposedMargin: "30",
  openPositions: [],
  pendingOrders: [],
};
const state: FinancialRiskState = {
  version: 1,
  missionPnl: "0",
  dailyPnl: "0",
  openRisk: "0",
  openNotional: "0",
  positions: 0,
  pendingOrders: 0,
  unresolvedEffects: false,
  missionActive: true,
  accountFrozen: false,
};
const assess = (patch: Partial<Parameters<typeof assessFinancialAction>[0]> = {}) =>
  assessFinancialAction({ action, envelope, facts, state, now, ...patch });
const target: FinancialRiskTarget = {
  id: "position",
  kind: "POSITION",
  orderType: null,
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  side: "BUY",
  volume: "0.02",
  entry: "2680",
  stopLoss: "2695",
  takeProfit: "2710",
  attributed: true,
  drifted: false,
  observedAt: now.toISOString(),
};
const identity = {
  version: 1 as const,
  mode: "SIMULATION" as const,
  provider: "metaapi",
  accountId: "account",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
};

describe("deterministic bounded financial risk", () => {
  it("uses exact broker loss-tick value and independently includes cost reserve", () => {
    expect(assess()).toMatchObject({
      decision: "ALLOW",
      riskAfter: "11.2",
      incrementalRisk: "11.2",
      notional: "5400.2",
      margin: "30",
    });
  });
  it("uses contract currency only when broker tick conversion is unavailable and currency matches", () => {
    expect(assess({ facts: { ...facts, lossTickValue: null } })).toMatchObject({
      decision: "ALLOW",
      riskAfter: "11.2",
    });
    expect(assess({ facts: { ...facts, lossTickValue: null, profitCurrency: "EUR" } })).toEqual({
      decision: "DENY",
      code: "UNKNOWN_CURRENCY_RISK",
    });
  });
  it.each([
    ["STALE_BROKER_STATE", { facts: { ...facts, observedAt: "2026-10-09T09:59:00Z" } }],
    ["IDENTITY_MISMATCH", { facts: { ...facts, accountId: "other" } }],
    [
      "QUOTE_IDENTITY_MISMATCH",
      { facts: { ...facts, quote: { ...facts.quote, instrumentId: "other" } } },
    ],
    ["ACCOUNT_UNAVAILABLE", { facts: { ...facts, connected: false } }],
    ["AMBIGUOUS_NETTING_ATTRIBUTION", { facts: { ...facts, accountMode: "NETTING" as const } }],
    ["UNRESOLVED_EFFECT", { state: { ...state, unresolvedEffects: true } }],
    ["MISSION_NOT_ACTIVE", { state: { ...state, accountFrozen: true } }],
    ["MISSION_NOT_ACTIVE", { envelope: { ...envelope, expiresAt: now.toISOString() } }],
    ["PER_TRADE_RISK_LIMIT", { envelope: { ...envelope, maxRiskPerTrade: "10" } }],
    [
      "OPEN_RISK_LIMIT",
      { state: { ...state, openRisk: "50" }, envelope: { ...envelope, maxDailyLoss: null } },
    ],
    ["MISSION_LOSS_LIMIT", { state: { ...state, missionPnl: "-90" } }],
    ["MISSION_LOSS_LIMIT", { state: { ...state, openRisk: "90" } }],
    ["DAILY_LOSS_LIMIT", { state: { ...state, dailyPnl: "-40" } }],
    ["EXPOSURE_COUNT_LIMIT", { state: { ...state, positions: 2 } }],
    ["NOTIONAL_LIMIT", { state: { ...state, openNotional: "5000" } }],
    ["MARGIN_LIMIT", { facts: { ...facts, freeMargin: "10" } }],
    ["UNKNOWN_MARGIN", { facts: { ...facts, proposedMargin: null } }],
    ["UNBOUNDED_LOSS", { action: { ...action, stopLoss: null } }],
    ["INVALID_VOLUME", { action: { ...action, volume: "0.015" } }],
    ["INVALID_PRICE_PRECISION", { action: { ...action, stopLoss: "2695.001" } }],
  ] as const)("denies %s without trusting model arithmetic", (code, patch) =>
    expect(assess(patch)).toEqual({ decision: "DENY", code }),
  );
  it("pending exposure requires bounded expiry and reserves the same stop risk", () => {
    const pending: FinancialAction = {
      ...action,
      operation: "OPEN",
      orderType: "LIMIT",
      price: "2699",
      stopLoss: "2694",
      expiresAt: "2026-10-09T20:00:00Z",
    };
    expect(assess({ action: pending })).toMatchObject({ decision: "ALLOW", riskAfter: "11" });
    expect(assess({ action: { ...pending, expiresAt: null } })).toEqual({
      decision: "DENY",
      code: "PENDING_EXPIRY_REQUIRED",
    });
    expect(assess({ action: pending, state: { ...state, pendingOrders: 2 } })).toEqual({
      decision: "DENY",
      code: "EXPOSURE_COUNT_LIMIT",
    });
  });
  it("exact supervision can tighten or close but cannot widen or open unrelated exposure", () => {
    const supervision = { ...envelope, supervisionPositionId: "position" };
    const modify: FinancialAction = {
      ...identity,
      operation: "MODIFY_PROTECTION",
      positionId: "position",
      stopLoss: "2699",
      takeProfit: "2710",
    };
    expect(assess({ action: modify, envelope: supervision, target })).toMatchObject({
      decision: "ALLOW",
      riskBefore: "10",
      riskAfter: "2",
      classification: "REDUCES_RISK",
    });
    expect(
      assess({ action: { ...modify, stopLoss: "2690" }, envelope: supervision, target }),
    ).toEqual({ decision: "DENY", code: "STOP_WIDENING_NOT_AUTHORIZED" });
    expect(assess({ envelope: supervision })).toEqual({
      decision: "DENY",
      code: "SUPERVISION_CANNOT_OPEN",
    });
    expect(assess({ action: modify, target: { ...target, drifted: true } })).toEqual({
      decision: "DENY",
      code: "TARGET_OWNERSHIP_CHANGED",
    });
  });
  it("allows a fully closing risk reduction under account freeze and validates partial remainder", () => {
    const close: FinancialAction = {
      ...identity,
      operation: "CLOSE_POSITION",
      positionId: "position",
      volume: null,
    };
    expect(
      assess({
        action: close,
        target,
        state: { ...state, accountFrozen: true, missionActive: false },
      }),
    ).toMatchObject({ decision: "ALLOW", riskAfter: "0" });
    expect(assess({ action: { ...close, volume: "0.01" }, target })).toMatchObject({
      decision: "ALLOW",
      riskAfter: "5",
    });
    expect(assess({ action: { ...close, volume: "0.02" }, target })).toEqual({
      decision: "DENY",
      code: "INVALID_PARTIAL_CLOSE",
    });
  });
  it("requires explicit permission for adding and hedging existing broker exposure", () => {
    const existing = { id: "manual", symbol: "GOLD.a", side: "BUY" as const, volume: "0.01" };
    expect(assess({ facts: { ...facts, openPositions: [existing] } })).toEqual({
      decision: "DENY",
      code: "ADDITIONAL_EXPOSURE_NOT_AUTHORIZED",
    });
    expect(assess({ facts: { ...facts, pendingOrders: [{ ...existing, side: "SELL" }] } })).toEqual(
      { decision: "DENY", code: "HEDGE_NOT_AUTHORIZED" },
    );
    expect(
      assess({
        facts: { ...facts, openPositions: [existing] },
        envelope: { ...envelope, riskIncreasePermissions: ["ADD_EXPOSURE"] },
      }),
    ).toMatchObject({ decision: "ALLOW" });
  });
  it("prices pending protection from the intended entry and rejects disguised exposure increases", () => {
    const pending: FinancialAction = {
      ...action,
      operation: "OPEN",
      orderType: "LIMIT",
      price: "2690",
      stopLoss: "2685",
      takeProfit: "2698",
      expiresAt: "2026-10-09T20:00:00Z",
    };
    expect(assess({ action: pending })).toMatchObject({ decision: "ALLOW", riskAfter: "11" });
    const orderTarget: FinancialRiskTarget = {
      ...target,
      kind: "ORDER",
      orderType: "LIMIT",
      entry: "2699",
      stopLoss: "2694",
    };
    const change: FinancialAction = {
      ...identity,
      operation: "MODIFY_ORDER",
      orderId: "position",
      volume: "0.03",
      price: "2699.5",
      stopLoss: "2699",
      takeProfit: "2710",
      expiresAt: "2026-10-09T20:00:00Z",
      stopLimitPrice: null,
    };
    expect(assess({ action: change, target: orderTarget })).toEqual({
      decision: "DENY",
      code: "PENDING_INCREASE_NOT_AUTHORIZED",
    });
    expect(
      assess({
        action: change,
        target: orderTarget,
        envelope: {
          ...envelope,
          riskIncreasePermissions: ["INCREASE_PENDING_VOLUME"],
          maxNotional: "6000",
        },
        state: { ...state, openRisk: "10", openNotional: "5398" },
      }),
    ).toEqual({ decision: "DENY", code: "NOTIONAL_LIMIT" });
  });
  it("binds all hard mandate permissions, limits, mode and finish behavior", () => {
    const original = tradingMandateFingerprint(envelope);
    for (const patch of [
      { maxMissionLoss: "101" },
      { maxDailyLoss: null },
      { allocatedCapital: "2001" },
      { maxNotional: "10001" },
      { maxMarginUsagePercent: "51" },
      { costReservePerTrade: "2" },
      { riskIncreasePermissions: ["HEDGE"] },
      { mode: "LIVE" },
      { botId: "peer" },
      { targetBehavior: "CANCEL_PENDING" },
      { supervisionPositionId: "position" },
      { allowedOrderTypes: ["MARKET"] },
      { supervisedOrderIds: ["order"] },
    ]) {
      expect(tradingMandateFingerprint({ ...envelope, ...patch })).not.toBe(original);
    }
    expect(
      tradingMandateFingerprint({
        ...envelope,
        allowedOrderTypes: ["STOP", "MARKET", "LIMIT", "MARKET"],
      }),
    ).toBe(original);
  });
  it("retains decimal precision and rounds risk upwards", () => {
    const value = "123456789012345678.000000000001";
    expect(financialDecimal(financialUnits(value))).toBe(value);
    expect(financialDecimal(financialUnits("-0.000000000001"))).toBe("-0.000000000001");
    expect(financialCeil(1n, 3n)).toBe(1n);
  });
});
