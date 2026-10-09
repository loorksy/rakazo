import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from "@klinecharts/pro";
import type { BrokerCandle, BrokerReadCommand, CloudChart } from "@rakazo/contracts";
import {
  BrokerCandleSchema,
  BrokerInstrumentDirectorySchema,
  BrokerLivePacketSchema,
  BrokerTimeframeSchema,
} from "@rakazo/contracts";
import { timeframeMillis } from "@rakazo/core";
import type { KLineData } from "klinecharts";

export function klinePeriod(timeframe: string): Period {
  const match = /^(\d+)(m|h|d|w|mn)$/.exec(timeframe);
  if (!match) throw new Error("Unavailable chart timeframe");
  return {
    multiplier: Number(match[1]),
    timespan:
      ({ m: "minute", h: "hour", d: "day", w: "week", mn: "month" } as Record<string, string>)[
        match[2] ?? ""
      ] ?? "",
    text: timeframe,
  };
}
export function brokerTimeframe(period: Period) {
  const unit = (
    { minute: "m", hour: "h", day: "d", week: "w", month: "mn" } as Record<string, string>
  )[period.timespan];
  return BrokerTimeframeSchema.parse(`${period.multiplier}${unit ?? ""}`);
}
/** Number conversion is exclusively the visual adapter; trusted financial state stays decimal text. */
export function candlePixels(candle: BrokerCandle): KLineData {
  return {
    timestamp: Date.parse(candle.openTime),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume ?? "0"),
  };
}
export interface BrokerChartTransport {
  read(command: BrokerReadCommand, signal: AbortSignal): Promise<unknown>;
  follow(
    accountId: string,
    instrumentIds: string[],
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>;
}
/** Reuses authenticated backend evidence; never the library's Polygon feed or arbitrary URLs. */
export class KlineBrokerDatafeed implements Datafeed {
  private readonly abort = new AbortController();
  private readonly refreshes = new Map<string, number>();
  private readonly subscriptions = new Map<string, AbortController>();
  private readonly latest = new Map<string, { point: KLineData; complete: boolean }>();
  constructor(
    private readonly chart: CloudChart,
    private readonly transport: BrokerChartTransport,
    private readonly onError: () => void,
    private readonly onPeriod?: (timeframe: string) => void,
  ) {}
  async searchSymbols(search = ""): Promise<SymbolInfo[]> {
    const directory = await this.transport.read(
      { operation: "instruments", accountId: this.chart.accountId },
      this.abort.signal,
    );
    return BrokerInstrumentDirectorySchema.parse(directory)
      .filter((row) => row.brokerSymbol.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 100)
      .map((row) => ({
        ticker: row.id,
        name: row.brokerSymbol,
        shortName: row.brokerSymbol,
        market: "broker",
      }));
  }
  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
  ): Promise<KLineData[]> {
    const timeframe = brokerTimeframe(period);
    this.onPeriod?.(timeframe);
    const end = Math.min(
      to,
      this.chart.state.viewport.to ? Date.parse(this.chart.state.viewport.to) : to,
    );
    const before = new Date(Math.min(Date.now(), end)).toISOString();
    const raw = await this.transport.read(
      {
        operation: "candles",
        accountId: this.chart.accountId,
        instrumentId: symbol.ticker,
        timeframe,
        before,
        limit: 1000,
      },
      this.abort.signal,
    );
    const candles = BrokerCandleSchema.array()
      .max(1000)
      .parse(raw)
      .filter(
        (candle) =>
          candle.accountId === this.chart.accountId &&
          candle.instrumentId === symbol.ticker &&
          candle.timeframe === timeframe,
      );
    const rows = [
      ...new Map(candles.map((c) => [Date.parse(c.openTime), candlePixels(c)])).values(),
    ]
      .filter((row) => row.timestamp >= from && row.timestamp <= end)
      .sort((a, b) => a.timestamp - b.timestamp);
    const last = rows.at(-1);
    if (
      last &&
      last.timestamp >= (this.latest.get(`${symbol.ticker}:${timeframe}`)?.point.timestamp ?? 0)
    )
      this.latest.set(`${symbol.ticker}:${timeframe}`, {
        point: last,
        complete: candles.find((c) => Date.parse(c.openTime) === last.timestamp)?.complete ?? true,
      });
    return rows;
  }
  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback) {
    const timeframe = brokerTimeframe(period);
    const key = `${symbol.ticker}:${timeframe}`;
    this.subscriptions.get(key)?.abort();
    const abort = new AbortController();
    this.subscriptions.set(key, abort);
    const signal = AbortSignal.any([this.abort.signal, abort.signal]);
    void (async () => {
      const stream = await this.transport.follow(this.chart.accountId, [symbol.ticker], signal);
      for await (const raw of stream) {
        if (signal.aborted) break;
        const packet = BrokerLivePacketSchema.parse(raw);
        for (const event of packet.events) {
          if (
            event.type !== "quote" ||
            event.quote.accountId !== this.chart.accountId ||
            event.quote.instrumentId !== symbol.ticker
          )
            continue;
          if (this.chart.state.viewport.to) continue;
          const last = this.latest.get(key);
          const quoteTime = Date.parse(event.quote.sourceTime);
          if (
            !last ||
            last.complete ||
            quoteTime >=
              last.point.timestamp + timeframeMillis(timeframe, new Date(last.point.timestamp))
          ) {
            if (Date.now() - (this.refreshes.get(key) ?? 0) >= 5000) {
              this.refreshes.set(key, Date.now());
              void this.transport
                .read(
                  {
                    operation: "candles",
                    accountId: this.chart.accountId,
                    instrumentId: symbol.ticker,
                    timeframe,
                    limit: 2,
                  },
                  signal,
                )
                .then((raw) => {
                  if (signal.aborted) return;
                  const candles = BrokerCandleSchema.array().max(2).parse(raw);
                  for (const candle of candles) {
                    if (
                      candle.accountId !== this.chart.accountId ||
                      candle.instrumentId !== symbol.ticker ||
                      candle.timeframe !== timeframe
                    )
                      continue;
                    const point = candlePixels(candle);
                    if (point.timestamp < (this.latest.get(key)?.point.timestamp ?? 0)) continue;
                    this.latest.set(key, { point, complete: candle.complete });
                    callback(point);
                  }
                })
                .catch(() => {
                  if (!signal.aborted) this.onError();
                });
            }
            continue;
          }
          if (quoteTime < last.point.timestamp) continue;
          // Tick projection only updates the currently loaded forming candle. Broker history
          // remains authoritative; it does not fabricate intervening completed candles.
          const price = Number(event.quote.bid);
          const next = {
            ...last.point,
            close: price,
            high: Math.max(last.point.high, price),
            low: Math.min(last.point.low, price),
          };
          this.latest.set(key, { point: next, complete: false });
          callback(next);
        }
      }
    })().catch(() => {
      if (!signal.aborted) this.onError();
    });
  }
  unsubscribe(symbol: SymbolInfo, period: Period) {
    const key = `${symbol.ticker}:${brokerTimeframe(period)}`;
    this.subscriptions.get(key)?.abort();
    this.subscriptions.delete(key);
  }
  close() {
    this.abort.abort();
    for (const abort of this.subscriptions.values()) abort.abort();
    this.subscriptions.clear();
    this.latest.clear();
    this.refreshes.clear();
  }
}
