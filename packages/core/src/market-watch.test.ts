import type { BrokerQuote, MarketCondition } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { observeMarketCondition } from "./market-watch.js";

const now = new Date("2026-10-09T12:00:00Z");
const quote: BrokerQuote = {
  version: 1,
  provider: "metaapi",
  accountId: "a",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  bid: "2700.000000000001",
  ask: "2700.1",
  sourceTime: now.toISOString(),
  receivedAt: now.toISOString(),
  revision: "q1",
};
function observe(comparison: MarketCondition["comparison"], previousValue: string | null = null) {
  return observeMarketCondition({
    condition: { version: 1, field: "BID", comparison, price: "2700" },
    quote,
    now,
    previousValue,
    previousSourceTime: null,
  });
}
describe("deterministic broker conditions", () => {
  it("evaluates thresholds at exact twelve-decimal precision", () => {
    expect(observe("AT_OR_ABOVE").fire).toBe(true);
    expect(observe("AT_OR_BELOW").fire).toBe(false);
    expect(observe("CROSS_ABOVE", "2700").fire).toBe(true);
    expect(observe("CROSS_ABOVE", "2700.000000000002").fire).toBe(false);
    expect(observe("CROSS_BELOW", "2700.000000000002").fire).toBe(false);
  });
  it("requires a previous observation to confirm a crossing", () => {
    expect(observe("CROSS_ABOVE").fire).toBe(false);
    expect(observe("CROSS_BELOW").fire).toBe(false);
  });
  it.each([-3000, 16000])("ignores stale/future provider timestamps (%s ms)", (age) => {
    expect(
      observeMarketCondition({
        condition: { version: 1, field: "ASK", comparison: "AT_OR_ABOVE", price: "2700" },
        quote,
        now: new Date(now.getTime() + age),
        previousValue: null,
        previousSourceTime: null,
      }),
    ).toMatchObject({ observed: false, fire: false });
  });
  it("ignores duplicated/out-of-order source events independently of wall-clock freshness", () => {
    const result = observeMarketCondition({
      condition: { version: 1, field: "BID", comparison: "AT_OR_ABOVE", price: "2700" },
      quote,
      now,
      previousValue: "2699",
      previousSourceTime: quote.sourceTime,
    });
    expect(result).toEqual({ observed: false, fire: false, value: "2699" });
  });
});
