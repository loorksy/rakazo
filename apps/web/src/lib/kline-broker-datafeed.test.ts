import type { BrokerCandle, BrokerReadCommand, CloudChart } from "@rakazo/contracts";
import { CloudChartSchema } from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { brokerTimeframe, KlineBrokerDatafeed, klinePeriod } from "./kline-broker-datafeed";

const time = "2026-10-09T08:00:00.000Z";
const symbol = { ticker: "instrument-a", name: "GOLD.a" };
const chart = CloudChartSchema.parse({
  id: "chart-a",
  ownerUserId: "owner",
  ownerBotId: null,
  scope: "PRIVATE",
  accountId: "account-a",
  instrumentId: "instrument-a",
  brokerSymbol: "GOLD.a",
  revision: 1,
  state: {
    version: 1,
    timeframe: "1h",
    viewport: { from: null, to: null, candleCount: 200, rightSpacing: 40 },
    drawings: [],
    indicators: [],
    preferences: { theme: "dark", timezone: "UTC" },
  },
  createdAt: time,
  updatedAt: time,
});
function candle(openTime = time, complete = false): BrokerCandle {
  return {
    version: 1,
    provider: "metaapi",
    accountId: "account-a",
    instrumentId: "instrument-a",
    brokerSymbol: "GOLD.a",
    timeframe: "1h",
    openTime,
    open: "2700.123456789",
    high: "2704",
    low: "2699",
    close: "2701",
    volume: "12",
    complete,
    fetchedAt: time,
    revision: openTime,
  };
}
function packet(sourceTime = "2026-10-09T08:30:00.000Z", bid = "2703") {
  return {
    generation: 1,
    events: [
      {
        type: "quote",
        quote: {
          version: 1,
          provider: "metaapi",
          accountId: "account-a",
          instrumentId: "instrument-a",
          brokerSymbol: "GOLD.a",
          bid,
          ask: "2710",
          sourceTime,
          receivedAt: sourceTime,
          revision: sourceTime,
        },
      },
    ],
  };
}
const symbolPeriod = klinePeriod("1h");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());
it.each(["1m", "15m", "4h", "1d", "1w", "1mn"])("preserves the deployed period %s", (timeframe) =>
  expect(brokerTimeframe(klinePeriod(timeframe))).toBe(timeframe),
);
it("loads account-scoped paged history, sorts and preserves trusted input precision", async () => {
  const original = candle();
  const read = vi
    .fn()
    .mockResolvedValue([
      original,
      candle("2026-10-09T07:00:00.000Z", true),
      { ...candle(), accountId: "another" },
      original,
    ]);
  const feed = new KlineBrokerDatafeed(chart, { read, follow: vi.fn() }, vi.fn());
  const rows = await feed.getHistoryKLineData(
    symbol,
    symbolPeriod,
    Date.parse("2026-10-09T06:00:00Z"),
    Date.parse("2026-10-09T08:00:00Z"),
  );
  expect(rows.map((r) => r.timestamp)).toEqual([
    Date.parse("2026-10-09T07:00:00Z"),
    Date.parse(time),
  ]);
  expect(read.mock.calls[0]?.[0]).toMatchObject({
    accountId: "account-a",
    instrumentId: "instrument-a",
    before: time,
    limit: 1000,
  });
  expect(original.open).toBe("2700.123456789");
  feed.close();
});
it("requests an earlier history page rather than repeating the saved viewport end", async () => {
  const historical: CloudChart = {
    ...chart,
    state: {
      ...chart.state,
      viewport: { ...chart.state.viewport, from: "2026-10-08T00:00:00Z", to: time },
    },
  };
  const read = vi.fn().mockResolvedValue([]);
  const feed = new KlineBrokerDatafeed(historical, { read, follow: vi.fn() }, vi.fn());
  await feed.getHistoryKLineData(
    symbol,
    symbolPeriod,
    Date.parse("2026-10-07T00:00:00Z"),
    Date.parse("2026-10-08T00:00:00Z"),
  );
  expect(read.mock.calls[0]?.[0].before).toBe("2026-10-08T00:00:00.000Z");
  feed.close();
});
it("updates the forming candle without fabricating completed market history", async () => {
  const callback = vi.fn();
  const read = vi.fn().mockResolvedValue([candle()]);
  const follow = vi.fn(async () =>
    (async function* () {
      yield packet();
      yield packet("2026-10-09T07:59:00Z");
    })(),
  );
  const feed = new KlineBrokerDatafeed(chart, { read, follow }, vi.fn());
  await feed.getHistoryKLineData(symbol, symbolPeriod, 0, Date.parse(time));
  feed.subscribe(symbol, symbolPeriod, callback);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  expect(callback.mock.calls[0]?.[0]).toMatchObject({
    timestamp: Date.parse(time),
    close: 2703,
    high: 2704,
  });
  expect(read).toHaveBeenCalledOnce();
  feed.close();
});
it("coalesces rollover history refresh and does not interpret a quote as candle completion", async () => {
  const callback = vi.fn();
  let resolveRead: (value: BrokerCandle[]) => void = () => {};
  const read = vi
    .fn()
    .mockResolvedValueOnce([candle()])
    .mockImplementation(
      () =>
        new Promise<BrokerCandle[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
  const follow = vi.fn(async () =>
    (async function* () {
      for (let i = 0; i < 10; i++) yield packet("2026-10-09T09:30:00Z");
    })(),
  );
  const feed = new KlineBrokerDatafeed(chart, { read, follow }, vi.fn());
  await feed.getHistoryKLineData(symbol, symbolPeriod, 0, Date.parse(time));
  feed.subscribe(symbol, symbolPeriod, callback);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(callback).not.toHaveBeenCalled();
  resolveRead([candle(time, true), candle("2026-10-09T09:00:00Z", false)]);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
  feed.close();
});
it("never writes live ticks into a historical viewport", async () => {
  const callback = vi.fn();
  const read = vi.fn().mockResolvedValue([candle()]);
  const follow = vi.fn(async () =>
    (async function* () {
      yield packet();
    })(),
  );
  const feed = new KlineBrokerDatafeed(
    {
      ...chart,
      state: {
        ...chart.state,
        viewport: { ...chart.state.viewport, from: "2026-10-08T00:00:00Z", to: time },
      },
    },
    { read, follow },
    vi.fn(),
  );
  await feed.getHistoryKLineData(symbol, symbolPeriod, 0, Date.parse(time));
  feed.subscribe(symbol, symbolPeriod, callback);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(callback).not.toHaveBeenCalled();
  feed.close();
});
it("close aborts provider reads and subscriptions without leaking provider errors", async () => {
  let readSignal: AbortSignal | undefined, followSignal: AbortSignal | undefined;
  const onError = vi.fn();
  const read = async (_cmd: BrokerReadCommand, signal: AbortSignal) => {
    readSignal = signal;
    return [candle()];
  };
  const follow = async (_account: string, _ids: string[], signal: AbortSignal) => {
    followSignal = signal;
    return (async function* () {
      yield packet();
      throw new Error("fixture-secret-sentinel");
    })();
  };
  const feed = new KlineBrokerDatafeed(chart, { read, follow }, onError);
  await feed.getHistoryKLineData(symbol, symbolPeriod, 0, Date.parse(time));
  feed.subscribe(symbol, symbolPeriod, vi.fn());
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith());
  feed.close();
  expect(readSignal?.aborted).toBe(true);
  expect(followSignal?.aborted).toBe(true);
  expect(JSON.stringify(onError.mock.calls)).not.toContain("fixture-secret-sentinel");
});
