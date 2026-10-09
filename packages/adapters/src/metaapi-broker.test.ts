import type { BrokerEvent } from "@rakazo/adapter-kit";
import type { SynchronizationListener } from "metaapi.cloud-sdk/esm-node";
import { describe, expect, it, vi } from "vitest";
import { MetaApiBrokerProvider } from "./metaapi-broker.js";
import {
  BrokerProviderError,
  brokerSdkNumber,
  normalizeAccount,
  normalizeCandles,
  normalizeOrders,
  normalizePositions,
  normalizeQuote,
  normalizeSpecification,
} from "./metaapi-normalize.js";

const at = "2026-10-09T12:00:00.000Z";
const accountInfo = {
  currency: "USD",
  balance: 10000,
  equity: 9998.25,
  margin: 100,
  freeMargin: 9898.25,
  platform: "mt5",
  tradeAllowed: true,
  type: "ACCOUNT_TRADE_MODE_DEMO",
  marginMode: "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING",
};
const quote = {
  symbol: "GOLD.a",
  lossTickValue: 1,
  bid: 2674.3,
  ask: 2674.5,
  time: new Date(at),
  token: "sentinel-must-never-leak",
};
const candle = {
  symbol: "GOLD.a",
  timeframe: "1h",
  time: new Date("2026-10-09T11:00:00Z"),
  open: 2670,
  high: 2680,
  low: 2669,
  close: 2674,
  tickVolume: 120,
};
const spec = {
  symbol: "GOLD.a",
  contractSize: 100,
  tickSize: 0.01,
  minVolume: 0.01,
  maxVolume: 200,
  volumeStep: 0.01,
  digits: 2,
  stopsLevel: 20,
  fillingModes: ["SYMBOL_FILLING_IOC"],
  tradeMode: "SYMBOL_TRADE_MODE_FULL",
  allowedOrderTypes: ["SYMBOL_ORDER_MARKET", "SYMBOL_ORDER_LIMIT", "SYMBOL_ORDER_STOP"],
  profitCurrency: "USD",
};
function fixture() {
  const listeners = new Set<SynchronizationListener>();
  const rpc = {
    connect: vi.fn(async () => {}),
    waitSynchronized: vi.fn(async () => {}),
    getAccountInformation: vi.fn(async () => accountInfo),
    getPositions: vi.fn(async () => []),
    getOrders: vi.fn(async () => []),
    getSymbols: vi.fn(async () => ["GOLD.a", "EURUSDm", "GOLD.a"]),
    getSymbolSpecification: vi.fn(async () => spec),
    getSymbolPrice: vi.fn(async () => quote),
    calculateMargin: vi.fn(async () => ({ margin: 32.1, token: "sentinel-must-never-leak" })),
    close: vi.fn(async () => {}),
  };
  const stream = {
    connect: vi.fn(async () => {}),
    waitSynchronized: vi.fn(async () => {}),
    addSynchronizationListener: vi.fn((listener: SynchronizationListener) => {
      listeners.add(listener);
    }),
    removeSynchronizationListener: vi.fn((listener: SynchronizationListener) => {
      listeners.delete(listener);
    }),
    subscribeToMarketData: vi.fn(async () => {}),
    unsubscribeFromMarketData: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const account = {
    region: "london",
    state: "DEPLOYED",
    connectionStatus: "CONNECTED",
    getRPCConnection: () => rpc,
    getStreamingConnection: () => stream,
    getHistoricalCandles: vi.fn(async () => [candle]),
  };
  const sdk = { metatraderAccountApi: { getAccount: vi.fn(async () => account) }, close: vi.fn() };
  const provider = new MetaApiBrokerProvider(
    () => sdk,
    () => new Date(at),
  );
  const connect = () =>
    provider.connect({
      accountId: "local-account",
      providerAccountId: "remote-id",
      region: "london",
      resolveCredential: async () => "fixture-secret",
    });
  return { listeners, rpc, stream, account, sdk, provider, connect };
}

describe("MetaApi read-only SDK boundary", () => {
  it("validates the account, normalizes reads, and never exposes raw fields or mutations", async () => {
    const f = fixture();
    const session = await f.connect();
    expect(await session.account()).toMatchObject({
      balance: "10000",
      equity: "9998.25",
      environment: "DEMO",
      accountMode: "HEDGING",
    });
    expect(await session.symbols()).toEqual(["EURUSDm", "GOLD.a"]);
    expect(await session.quote("GOLD.a", "instrument-gold")).toMatchObject({
      bid: "2674.3",
      sourceTime: at,
      accountId: "local-account",
    });
    expect(JSON.stringify(await session.quote("GOLD.a", "instrument-gold"))).not.toContain(
      quote.token,
    );
    expect(await session.specification("GOLD.a")).toMatchObject({
      orderTypes: ["MARKET", "LIMIT", "STOP"],
      tickSize: "0.01",
    });
    expect(await session.capabilities()).toMatchObject({ operations: [], nativeOco: false });
    expect(await session.positions()).toEqual([]);
    expect(await session.orders()).toEqual([]);
    expect("execute" in session).toBe(false);
    await session.close();
    await session.close();
    expect(f.sdk.close).toHaveBeenCalledTimes(1);
    await expect(session.account()).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
  it("fetches bounded historical pages with candle completeness, exact identity and ascending order", async () => {
    const f = fixture();
    const session = await f.connect();
    const values = await session.candles({
      symbol: "GOLD.a",
      instrumentId: "gold",
      timeframe: "1h",
      before: at,
      limit: 500,
    });
    expect(values[0]).toMatchObject({
      openTime: "2026-10-09T11:00:00.000Z",
      complete: true,
      volume: "120",
      provider: "metaapi",
    });
    expect(f.account.getHistoricalCandles).toHaveBeenCalledWith("GOLD.a", "1h", new Date(at), 500);
    await expect(
      session.candles({ symbol: "GOLD.a", instrumentId: "gold", timeframe: "1h", limit: 1001 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await session.close();
  });
  it("rejects disconnected or mismatched regions without deployment or secret leakage", async () => {
    const f = fixture();
    f.account.connectionStatus = "DISCONNECTED";
    await expect(f.connect()).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(f.sdk.close).toHaveBeenCalledOnce();
    expect(f.rpc.connect).not.toHaveBeenCalled();
    await expect(
      f.provider.connect({
        accountId: "a",
        providerAccountId: "b",
        region: "evil.example",
        resolveCredential: async () => "fixture-secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("redacts provider exceptions and distinguishes rate limiting", async () => {
    const f = fixture();
    const session = await f.connect();
    f.rpc.getPositions.mockRejectedValueOnce({
      statusCode: 429,
      message: "fixture-secret",
      headers: { authorization: "fixture-secret" },
    });
    await expect(session.positions()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Broker operation failed: RATE_LIMITED",
    });
    f.rpc.getPositions.mockRejectedValueOnce(new Error("sentinel-must-never-leak"));
    await expect(session.positions()).rejects.toMatchObject({
      message: "Broker operation failed: UNAVAILABLE",
    });
    await session.close();
  });
  it("shares subscriptions atomically across listeners and closes without stale callbacks", async () => {
    const f = fixture();
    const session = await f.connect();
    const events: BrokerEvent[] = [];
    const [releaseA, releaseB] = await Promise.all([
      session.subscribe([{ symbol: "GOLD.a", instrumentId: "gold" }], (event) =>
        events.push(event),
      ),
      session.subscribe([{ symbol: "GOLD.a", instrumentId: "gold" }], (event) =>
        events.push(event),
      ),
    ]);
    expect(f.stream.subscribeToMarketData).toHaveBeenCalledTimes(1);
    for (const listener of f.listeners)
      await listener.onSymbolPricesUpdated("instance", [quote], 1, 1, 1, 1, 1);
    expect(events).toHaveLength(2);
    await releaseA();
    expect(f.stream.unsubscribeFromMarketData).not.toHaveBeenCalled();
    await releaseB();
    await releaseB();
    expect(f.stream.unsubscribeFromMarketData).toHaveBeenCalledTimes(1);
    await session.close();
    expect(f.listeners.size).toBe(0);
  });
  it("rolls back partial subscription failure without deadlock or raw errors", async () => {
    const f = fixture();
    const session = await f.connect();
    f.stream.subscribeToMarketData
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fixture-secret"));
    await expect(
      session.subscribe(
        [
          { symbol: "GOLD.a", instrumentId: "gold" },
          { symbol: "EURUSDm", instrumentId: "eurusd" },
        ],
        () => {},
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.listeners.size).toBe(0);
    expect(f.stream.unsubscribeFromMarketData).toHaveBeenCalledOnce();
    await session.close();
  });
});

describe("broker financial normalization", () => {
  it("does not confuse MetaApi hosting mode with broker account environment or margin mode", () => {
    expect(
      normalizeAccount(
        {
          ...accountInfo,
          type: "ACCOUNT_TRADE_MODE_REAL",
          marginMode: "ACCOUNT_MARGIN_MODE_RETAIL_NETTING",
        },
        "a",
        at,
      ),
    ).toMatchObject({ environment: "REAL", accountMode: "NETTING" });
    expect(
      normalizeAccount({ ...accountInfo, investorMode: true, marginMode: "new" }, "a", at),
    ).toMatchObject({ accountMode: "UNKNOWN", tradingAllowed: false });
  });
  it("normalizes position and pending-order attribution without guessing missing broker facts", () => {
    expect(
      normalizePositions(
        [
          {
            id: "p",
            symbol: "GOLD.a",
            type: "POSITION_TYPE_BUY",
            volume: 0.1,
            openPrice: 2600,
            currentPrice: 2610,
            profit: 100,
            swap: -1.5,
            commission: -2,
            stopLoss: 0,
          },
        ],
        "a",
        at,
      )[0],
    ).toMatchObject({ volume: "0.1", stopLoss: null, swap: "-1.5", clientId: null });
    expect(
      normalizeOrders(
        [
          {
            id: "o",
            symbol: "GOLD.a",
            type: "ORDER_TYPE_SELL_STOP_LIMIT",
            currentVolume: 0.1,
            openPrice: 2500,
            stopLimitPrice: 2490,
          },
        ],
        "a",
        at,
      )[0],
    ).toMatchObject({ side: "SELL", orderType: "STOP_LIMIT", volume: "0.1" });
  });
  it("rejects financial corruption, mismatched symbols and unsafe precision", () => {
    expect(() => normalizeQuote({ ...quote, bid: Number.NaN }, "a", "GOLD.a", "gold", at)).toThrow(
      BrokerProviderError,
    );
    expect(() => normalizeQuote({ ...quote, ask: 2600 }, "a", "GOLD.a", "gold", at)).toThrow(
      BrokerProviderError,
    );
    expect(() => normalizeQuote(quote, "a", "XAUUSD", "gold", at)).toThrow(BrokerProviderError);
    expect(() => normalizeSpecification({ ...spec, tickSize: 1e-20 }, "a", "GOLD.a", at)).toThrow(
      BrokerProviderError,
    );
    expect(
      normalizeSpecification({ ...spec, allowedOrderTypes: undefined }, "a", "GOLD.a", at)
        .orderTypes,
    ).toEqual([]);
  });
  it("deduplicates and sorts history, preserves open candles and rejects inconsistent OHLC", () => {
    const current = { ...candle, time: new Date(at) };
    const values = normalizeCandles([current, candle, candle], "a", "GOLD.a", "gold", "1h", at);
    expect(values).toHaveLength(2);
    expect(values.map((value) => value.complete)).toEqual([true, false]);
    expect(() =>
      normalizeCandles([{ ...candle, high: 2600 }], "a", "GOLD.a", "gold", "1h", at),
    ).toThrow(BrokerProviderError);
  });
});

describe("provider numeric normalization", () => {
  it.each([1e-8, "1e-8", "0.000000010000", "1.000e-8"])(
    "preserves tiny tick sizes %s without floating-point re-rounding",
    (tickSize) => {
      expect(normalizeSpecification({ ...spec, tickSize }, "a", "GOLD.a", at).tickSize).toBe(
        "0.00000001",
      );
    },
  );
  it.each([1e-20, "1e-1000", "1e1000", 9007199254740992, "NaN", "Infinity"])(
    "rejects unrepresentable financial input %s",
    (tickSize) => {
      expect(() => normalizeSpecification({ ...spec, tickSize }, "a", "GOLD.a", at)).toThrow(
        BrokerProviderError,
      );
    },
  );
  it("preserves signed provider P&L and never converts exact large text amounts to Number", () => {
    expect(
      normalizeAccount({ ...accountInfo, balance: "9007199254740992", equity: "-1e-8" }, "a", at),
    ).toMatchObject({ balance: "9007199254740992", equity: "-0.00000001" });
  });
});

describe("trusted broker risk preflight", () => {
  const action = {
    version: 1 as const,
    mode: "SIMULATION" as const,
    provider: "metaapi",
    accountId: "local-account",
    instrumentId: "gold",
    brokerSymbol: "GOLD.a",
    operation: "OPEN" as const,
    side: "BUY" as const,
    orderType: "MARKET" as const,
    volume: "0.02",
    price: null,
    stopLimitPrice: null,
    expiresAt: null,
    fillingMode: null,
    stopLoss: "2670",
    takeProfit: "2680",
  };
  it("obtains independent margin and account-currency tick evidence without sending a trade", async () => {
    const f = fixture();
    const session = await f.connect();
    if (!session.preflight) throw new Error("MetaApi preflight missing");
    const facts = await session.preflight(action);
    expect(f.rpc.calculateMargin).toHaveBeenCalledWith({
      symbol: "GOLD.a",
      type: "ORDER_TYPE_BUY",
      volume: 0.02,
      openPrice: 2674.5,
    });
    expect(facts).toMatchObject({
      proposedMargin: "32.1",
      lossTickValue: "1",
      contractSize: "100",
      currency: "USD",
      openPositions: [],
      pendingOrders: [],
      accountMode: "HEDGING",
      connected: true,
    });
    expect(JSON.stringify(facts)).not.toContain("sentinel-must-never-leak");
    expect(Object.keys(f.rpc)).not.toContain("trade");
    await session.close();
  });
  it("refuses account mismatch before provider reads and redacts SDK margin errors", async () => {
    const f = fixture();
    const session = await f.connect();
    if (!session.preflight) throw new Error("MetaApi preflight missing");
    await expect(session.preflight({ ...action, accountId: "foreign" })).rejects.toThrow(
      "INVALID_REQUEST",
    );
    expect(f.rpc.calculateMargin).not.toHaveBeenCalled();
    f.rpc.calculateMargin.mockRejectedValueOnce(
      new Error("Authorization: sentinel-must-never-leak"),
    );
    await expect(session.preflight(action)).rejects.toThrow("UNAVAILABLE");
    await session.close();
  });
  it("allows only financial numeric values whose SDK wire round trip preserves decimal text", () => {
    expect(brokerSdkNumber("0.00000001")).toBe(1e-8);
    expect(brokerSdkNumber("0.02")).toBe(0.02);
    expect(() => brokerSdkNumber("9007199254740993")).toThrow();
    expect(() => brokerSdkNumber("123456789012345678.123456789012")).toThrow();
  });
});
