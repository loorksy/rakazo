import { describe, expect, it } from "vitest";
import {
  BrokerCandleSchema,
  BrokerQuoteSchema,
  PositiveTradingDecimalSchema,
  TradingAuthorityEnvelopeSchema,
  TradingCapabilitiesSchema,
} from "./trading.js";

const identity = {
  version: 1,
  provider: "fixture",
  accountId: "account-a",
  instrumentId: "broker:GOLD.a",
  brokerSymbol: "GOLD.a",
  revision: "revision-1",
};
const time = "2026-10-08T20:00:00Z";

describe("provider-neutral trading contracts", () => {
  it("preserves account/symbol identity and both quote timestamps", () => {
    const quote = BrokerQuoteSchema.parse({
      ...identity,
      bid: "2700.1200",
      ask: "2700.14",
      sourceTime: time,
      receivedAt: "2026-10-08T20:00:01Z",
    });
    expect(quote).toMatchObject({
      accountId: "account-a",
      brokerSymbol: "GOLD.a",
      bid: "2700.12",
      sourceTime: time,
      receivedAt: "2026-10-08T20:00:01Z",
    });
  });
  it("preserves candle finality and unknown volume rather than inventing values", () => {
    const candle = {
      ...identity,
      timeframe: "H1",
      openTime: time,
      open: "2700",
      high: "2710",
      low: "2690",
      close: "2705",
      volume: null,
      complete: false,
      fetchedAt: time,
    };
    expect(BrokerCandleSchema.parse(candle)).toMatchObject({ volume: null, complete: false });
    expect(BrokerCandleSchema.parse({ ...candle, complete: true })).toMatchObject({
      complete: true,
    });
    expect(() =>
      BrokerCandleSchema.parse({ ...candle, openTime: "2026-10-08T20:00:00" }),
    ).toThrow();
  });
  it("rejects credential-bearing provider output and invalid symbol control characters", () => {
    const quote = { ...identity, bid: "2700", ask: "2701", sourceTime: time, receivedAt: time };
    expect(() =>
      BrokerQuoteSchema.parse({ ...quote, token: "test-only-secret-sentinel" }),
    ).toThrow();
    expect(() => BrokerQuoteSchema.parse({ ...quote, brokerSymbol: "GOLD\n" })).toThrow();
    expect(() => BrokerQuoteSchema.parse({ ...quote, bid: 2700 })).toThrow();
  });
  it("permits a read-only provider without inventing execution or account mode", () => {
    const capabilities = TradingCapabilitiesSchema.parse({
      version: 1,
      provider: "fixture",
      accountId: "account-a",
      environment: "DEMO",
      accountMode: "UNKNOWN",
      quotes: true,
      quoteStreaming: false,
      candles: true,
      historicalCandles: true,
      accountEvents: false,
      accountRead: false,
      positionsRead: false,
      ordersRead: false,
      symbolSpecifications: false,
      operations: [],
      orderTypes: [],
      partialClose: false,
      protectiveStops: false,
      nativeOco: false,
      clientReferences: false,
      verifiedAt: time,
      revision: "v1",
    });
    expect(capabilities.operations).toEqual([]);
    expect(capabilities.accountMode).toBe("UNKNOWN");
    expect(capabilities.environment).toBe("DEMO");
  });
  it("does not accept numerical coercion or effectively-zero positive amounts", () => {
    expect(PositiveTradingDecimalSchema.parse("0.000000000001")).toBe("0.000000000001");
    expect(() => PositiveTradingDecimalSchema.parse("0.000000000000")).toThrow();
    expect(() => PositiveTradingDecimalSchema.parse(0.1)).toThrow();
    expect(() => PositiveTradingDecimalSchema.parse("1e-12")).toThrow();
  });
  it("rejects inverted spreads without rounding decimal prices through Number", () => {
    const quote = {
      ...identity,
      sourceTime: time,
      receivedAt: time,
      bid: "9007199254740993.000000000002",
      ask: "9007199254740993.000000000001",
    };
    expect(() => BrokerQuoteSchema.parse(quote)).toThrow();
    expect(() => BrokerQuoteSchema.parse({ ...quote, ask: quote.bid })).not.toThrow();
  });
  it.each([{ high: "2699" }, { low: "2701" }, { close: "2711" }, { open: "2689" }])(
    "rejects inconsistent candle bounds %o",
    (change) => {
      expect(() =>
        BrokerCandleSchema.parse({
          ...identity,
          timeframe: "H1",
          openTime: time,
          open: "2700",
          high: "2710",
          low: "2690",
          close: "2705",
          volume: null,
          complete: true,
          fetchedAt: time,
          ...change,
        }),
      ).toThrow();
    },
  );
  it("requires explicit hard limits and breach/expiry behavior, not a profit objective", () => {
    expect(() =>
      TradingAuthorityEnvelopeSchema.parse({
        ownerId: "owner",
        targetProfit: "300",
        duration: "48h",
        approved: true,
      }),
    ).toThrow();
  });
});
