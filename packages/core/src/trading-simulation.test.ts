import type { FinancialAction, FinancialRiskFacts, SimulationBookState } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { applySimulationAction, simulationPnl, valueSimulationBook } from "./trading-simulation.js";

const now = new Date("2026-10-09T10:00:00Z");
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
  margin: "0",
  freeMargin: "10000",
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
const empty: SimulationBookState = {
  version: 1,
  accountId: "account",
  mode: "SIMULATION",
  currency: "USD",
  initialEquity: "10000",
  balance: "10000",
  positions: [],
  orders: [],
  performance: [],
};
const attribution = { effectId: "open", mandateId: "mission", goalId: "goal", planVersion: 1 };
const apply = (
  state = empty,
  current: FinancialAction = action,
  currentFacts = facts,
  identity = attribution,
) =>
  applySimulationAction({
    state,
    action: current,
    facts: currentFacts,
    attribution: identity,
    now,
  });
function close(volume: string | null = null): FinancialAction {
  return {
    version: 1,
    provider: "metaapi",
    mode: "SIMULATION",
    accountId: "account",
    instrumentId: "gold",
    brokerSymbol: "GOLD.a",
    operation: "CLOSE_POSITION",
    positionId: "sim_open",
    volume,
  };
}
describe("deterministic simulation provider calculations", () => {
  it("fills at exact side-specific broker quotes without mutating the input", () => {
    const buy = apply();
    const sell = apply(empty, { ...action, side: "SELL", stopLoss: "2705", takeProfit: "2690" });
    expect(buy.state.positions[0]?.entry).toBe("2700.1");
    expect(sell.state.positions[0]?.entry).toBe("2700");
    expect(empty.positions).toHaveLength(0);
    expect(buy.outcome).toEqual({
      version: 1,
      status: "SUCCEEDED",
      providerReference: "sim_open",
      code: null,
    });
    expect(valueSimulationBook(buy.state, [facts.quote], now)).toMatchObject({
      equity: "9999.8",
      margin: "30",
      freeMargin: "9969.8",
    });
  });
  it("realizes exact spread/price P&L separately for each mandate and UTC day", () => {
    const opened = apply().state;
    const closed = apply(
      opened,
      close(),
      { ...facts, quote: { ...facts.quote, bid: "2705", ask: "2705.1" } },
      { ...attribution, effectId: "close" },
    );
    expect(closed.state).toMatchObject({
      balance: "10009.8",
      positions: [],
      performance: [
        { mandateId: "mission", realized: "9.8", day: "2026-10-09", dailyRealized: "9.8" },
      ],
    });
    expect(closed.releasedEffectIds).toEqual(["open"]);
  });
  it("validates partial close and scales remaining margin conservatively", () => {
    const partial = apply(apply().state, close("0.01"), facts, {
      ...attribution,
      effectId: "partial",
    });
    expect(partial.state).toMatchObject({
      balance: "9999.9",
      positions: [{ volume: "0.01", margin: "15" }],
    });
    expect(partial.releasedEffectIds).toEqual([]);
    expect(() => apply(apply().state, close("0.015"))).toThrow("INVALID_VOLUME");
    expect(() => apply(apply().state, close("0.02"), facts)).not.toThrow();
    expect(() => apply(apply().state, close("0.01"), { ...facts, partialClose: false })).toThrow(
      "PARTIAL_CLOSE_UNSUPPORTED",
    );
  });
  it.each(["LIMIT", "STOP"] as const)(
    "persists a %s order without inventing a filled position",
    (orderType) => {
      const pending: FinancialAction = {
        ...action,
        orderType,
        price: orderType === "LIMIT" ? "2699" : "2701",
        expiresAt: "2026-10-09T12:00:00Z",
      };
      const placed = apply(empty, pending);
      expect(placed.state.positions).toHaveLength(0);
      expect(placed.state.orders[0]).toMatchObject({
        id: "sim_open",
        orderType,
        originEffectId: "open",
      });
      const cancelled = apply(
        placed.state,
        {
          version: 1,
          mode: "SIMULATION",
          provider: "metaapi",
          accountId: "account",
          instrumentId: "gold",
          brokerSymbol: "GOLD.a",
          operation: "CANCEL_ORDER",
          orderId: "sim_open",
        },
        facts,
        { ...attribution, effectId: "cancel" },
      );
      expect(cancelled.state.orders).toEqual([]);
      expect(cancelled.releasedEffectIds).toEqual(["open"]);
    },
  );
  it("updates exact order terms and protection without changing provenance", () => {
    const placed = apply(empty, {
      ...action,
      orderType: "LIMIT",
      price: "2699",
      expiresAt: "2026-10-09T12:00:00Z",
    }).state;
    const updated = apply(
      placed,
      {
        version: 1,
        mode: "SIMULATION",
        provider: "metaapi",
        accountId: "account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "MODIFY_ORDER",
        orderId: "sim_open",
        volume: "0.01",
        price: "2698",
        stopLoss: "2694",
        takeProfit: "2710",
        expiresAt: "2026-10-09T13:00:00Z",
        stopLimitPrice: null,
      },
      { ...facts, proposedMargin: "15" },
      { ...attribution, effectId: "modify" },
    );
    expect(updated.state.orders[0]).toMatchObject({
      entry: "2698",
      volume: "0.01",
      margin: "15",
      originEffectId: "open",
      planVersion: 1,
    });
    const protection = apply(
      apply().state,
      {
        version: 1,
        mode: "SIMULATION",
        provider: "metaapi",
        accountId: "account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "MODIFY_PROTECTION",
        positionId: "sim_open",
        stopLoss: "2699",
        takeProfit: "2720",
      },
      facts,
      { ...attribution, effectId: "protect" },
    );
    expect(protection.state.positions[0]).toMatchObject({
      stopLoss: "2699",
      takeProfit: "2720",
      originEffectId: "open",
    });
  });
  it("rejects LIVE, mixed accounts, stale quotes, duplicate actions and unowned positions", () => {
    expect(() => apply(empty, { ...action, mode: "LIVE" })).toThrow("IDENTITY_MISMATCH");
    expect(() => apply(empty, { ...action, accountId: "foreign" })).toThrow("IDENTITY_MISMATCH");
    expect(() =>
      apply(empty, action, {
        ...facts,
        quote: { ...facts.quote, sourceTime: "2026-10-09T09:59:00Z" },
      }),
    ).toThrow("STALE_QUOTE");
    expect(() => apply(apply().state)).toThrow("DUPLICATE_ACTION");
    expect(() =>
      apply(apply().state, close(), facts, {
        ...attribution,
        mandateId: "another",
        effectId: "close",
      }),
    ).toThrow("TARGET_UNAVAILABLE");
  });
  it("requires exact quotes for every open instrument rather than borrowing another price", () => {
    const book = apply().state;
    expect(() =>
      valueSimulationBook(book, [{ ...facts.quote, instrumentId: "other" }], now),
    ).toThrow("QUOTE_REQUIRED");
    expect(() =>
      valueSimulationBook(book, [{ ...facts.quote, receivedAt: "2026-10-09T09:00:00Z" }], now),
    ).toThrow("STALE_QUOTE");
  });
  it("never rounds fractional losses in the profitable direction", () => {
    const position = apply().state.positions[0];
    if (!position) throw new Error("Expected fixture position");
    expect(
      simulationPnl(
        { ...position, entry: "1", contractSize: "0.000000000001", volume: "0.000000000001" },
        "0.5",
      ),
    ).toBe("-0.000000000001");
  });
});
