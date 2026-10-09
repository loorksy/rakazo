import { createHash } from "node:crypto";
import type {
  BrokerAccountState,
  BrokerOrder,
  BrokerPosition,
  BrokerSymbolSpecification,
} from "@rakazo/adapter-kit";
import { BrokerCandleSchema, BrokerQuoteSchema, TradingDecimalSchema } from "@rakazo/contracts";
import { z } from "zod";

export class BrokerProviderError extends Error {
  constructor(
    readonly code:
      | "UNAVAILABLE"
      | "INVALID_RESPONSE"
      | "DISCONNECTED"
      | "INVALID_REQUEST"
      | "RATE_LIMITED",
  ) {
    super(`Broker operation failed: ${code}`);
    this.name = "BrokerProviderError";
  }
}

/** Never pass SDK exceptions, request bodies or authorization headers to tools/logs. */
export function sanitizedBrokerError(error: unknown): BrokerProviderError {
  if (error instanceof BrokerProviderError) return error;
  const code = z.object({ statusCode: z.number().optional() }).safeParse(error);
  return new BrokerProviderError(
    code.success && code.data.statusCode === 429 ? "RATE_LIMITED" : "UNAVAILABLE",
  );
}

const text = z.string().min(1).max(256);
/** Expand provider scientific notation as decimal text; never round an unsafe numeric integer. */
function providerDecimal(value: string | number): string {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
    return "invalid";
  const raw = String(value);
  if (raw.length > 64) return "invalid";
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,3})$/.exec(raw);
  if (!match) return raw;
  const sign = match[1] ?? "";
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  if (Math.abs(exponent) > 30) return "invalid";
  const digits = whole + fraction;
  const offset = whole.length + exponent;
  const expanded =
    offset <= 0
      ? `0.${"0".repeat(-offset)}${digits}`
      : offset >= digits.length
        ? `${digits}${"0".repeat(offset - digits.length)}`
        : `${digits.slice(0, offset)}.${digits.slice(offset)}`;
  return sign + expanded.replace(/^0+(?=\d)/, "");
}
const numeric = z.union([z.string(), z.number().finite()]).transform((value, context) => {
  const result = TradingDecimalSchema.safeParse(providerDecimal(value));
  if (!result.success) {
    context.addIssue({ code: "custom", message: "Invalid bounded financial decimal" });
    return z.NEVER;
  }
  return result.data;
});
const signed = z.union([z.string(), z.number().finite()]).transform((value, context) => {
  const raw = providerDecimal(value);
  const negative = raw.startsWith("-");
  const result = TradingDecimalSchema.safeParse(negative ? raw.slice(1) : raw);
  if (!result.success) {
    context.addIssue({ code: "custom", message: "Invalid bounded financial decimal" });
    return z.NEVER;
  }
  return negative && result.data !== "0" ? `-${result.data}` : result.data;
});
const time = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value).toISOString());
const nullablePrice = numeric
  .nullish()
  .transform((value) => (value === undefined || value === "0" ? null : value));
function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BrokerProviderError("INVALID_RESPONSE");
  return result.data;
}

export function normalizeAccount(
  input: unknown,
  accountId: string,
  observedAt: string,
): BrokerAccountState {
  const raw = parse(
    z.object({
      currency: text,
      balance: signed,
      equity: signed,
      margin: numeric,
      freeMargin: signed,
      platform: z.enum(["mt4", "mt5"]),
      tradeAllowed: z.boolean(),
      investorMode: z.boolean().optional(),
      type: z.enum([
        "ACCOUNT_TRADE_MODE_REAL",
        "ACCOUNT_TRADE_MODE_DEMO",
        "ACCOUNT_TRADE_MODE_CONTEST",
      ]),
      marginMode: text,
    }),
    input,
  );
  return {
    accountId,
    currency: raw.currency,
    balance: raw.balance,
    equity: raw.equity,
    margin: raw.margin,
    freeMargin: raw.freeMargin,
    platform: raw.platform,
    environment: raw.type === "ACCOUNT_TRADE_MODE_REAL" ? "REAL" : "DEMO",
    accountMode:
      raw.marginMode === "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING"
        ? "HEDGING"
        : ["ACCOUNT_MARGIN_MODE_RETAIL_NETTING", "ACCOUNT_MARGIN_MODE_EXCHANGE"].includes(
              raw.marginMode,
            )
          ? "NETTING"
          : "UNKNOWN",
    tradingAllowed: raw.tradeAllowed && raw.investorMode !== true,
    observedAt,
  };
}

export function normalizePositions(
  input: unknown,
  accountId: string,
  observedAt: string,
): BrokerPosition[] {
  return parse(
    z
      .array(
        z.object({
          id: text,
          symbol: text,
          type: z.enum(["POSITION_TYPE_BUY", "POSITION_TYPE_SELL"]),
          volume: numeric,
          openPrice: numeric,
          currentPrice: numeric,
          stopLoss: nullablePrice,
          takeProfit: nullablePrice,
          profit: signed,
          swap: signed,
          commission: signed,
          clientId: text.nullish(),
        }),
      )
      .max(10000),
    input,
  ).map((raw) => ({
    id: raw.id,
    accountId,
    symbol: raw.symbol,
    side: raw.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL",
    volume: raw.volume,
    entry: raw.openPrice,
    currentPrice: raw.currentPrice,
    stopLoss: raw.stopLoss,
    takeProfit: raw.takeProfit,
    profit: raw.profit,
    swap: raw.swap,
    commission: raw.commission,
    clientId: raw.clientId ?? null,
    observedAt,
  }));
}

export function normalizeOrders(
  input: unknown,
  accountId: string,
  observedAt: string,
): BrokerOrder[] {
  return parse(
    z
      .array(
        z.object({
          id: text,
          symbol: text,
          type: z.enum([
            "ORDER_TYPE_BUY_LIMIT",
            "ORDER_TYPE_SELL_LIMIT",
            "ORDER_TYPE_BUY_STOP",
            "ORDER_TYPE_SELL_STOP",
            "ORDER_TYPE_BUY_STOP_LIMIT",
            "ORDER_TYPE_SELL_STOP_LIMIT",
          ]),
          currentVolume: numeric,
          openPrice: numeric,
          stopLimitPrice: nullablePrice,
          stopLoss: nullablePrice,
          takeProfit: nullablePrice,
          expirationTime: time.nullish(),
          clientId: text.nullish(),
        }),
      )
      .max(10000),
    input,
  ).map((raw) => ({
    id: raw.id,
    accountId,
    symbol: raw.symbol,
    side: raw.type.startsWith("ORDER_TYPE_BUY_") ? "BUY" : "SELL",
    orderType: raw.type.endsWith("STOP_LIMIT")
      ? "STOP_LIMIT"
      : raw.type.endsWith("LIMIT")
        ? "LIMIT"
        : "STOP",
    volume: raw.currentVolume,
    price: raw.openPrice,
    stopLimitPrice: raw.stopLimitPrice,
    stopLoss: raw.stopLoss,
    takeProfit: raw.takeProfit,
    expiresAt: raw.expirationTime ?? null,
    clientId: raw.clientId ?? null,
    observedAt,
  }));
}

export function normalizeSpecification(
  input: unknown,
  accountId: string,
  symbol: string,
  verifiedAt: string,
): BrokerSymbolSpecification {
  const raw = parse(
    z.object({
      symbol: text,
      description: z.string().max(1000).optional(),
      baseCurrency: text.optional(),
      profitCurrency: text.optional(),
      tickSize: numeric,
      minVolume: numeric,
      maxVolume: numeric,
      volumeStep: numeric,
      digits: z.number().int().min(0).max(12),
      stopsLevel: z.number().int().nonnegative(),
      tradeMode: text.optional(),
      fillingModes: z.array(text).max(16),
      allowedOrderTypes: z.array(text).max(32).optional(),
      tradeSessions: z
        .record(z.string(), z.array(z.object({ from: text, to: text })).max(32))
        .optional(),
    }),
    input,
  );
  if (raw.symbol !== symbol || [raw.tickSize, raw.minVolume, raw.volumeStep].includes("0"))
    throw new BrokerProviderError("INVALID_RESPONSE");
  // Never infer every order type from the existence of SDK methods.
  const orderTypes: BrokerSymbolSpecification["orderTypes"] = [];
  const supported = raw.allowedOrderTypes ?? [];
  if (supported.includes("SYMBOL_ORDER_MARKET")) orderTypes.push("MARKET");
  if (supported.includes("SYMBOL_ORDER_LIMIT")) orderTypes.push("LIMIT");
  if (supported.includes("SYMBOL_ORDER_STOP")) orderTypes.push("STOP");
  if (supported.includes("SYMBOL_ORDER_STOP_LIMIT")) orderTypes.push("STOP_LIMIT");
  return {
    accountId,
    symbol,
    description: raw.description ?? symbol,
    baseCurrency: raw.baseCurrency ?? null,
    quoteCurrency: raw.profitCurrency ?? null,
    tickSize: raw.tickSize,
    minVolume: raw.minVolume,
    maxVolume: raw.maxVolume,
    volumeStep: raw.volumeStep,
    digits: raw.digits,
    stopsLevel: raw.stopsLevel,
    tradeMode: raw.tradeMode ?? "UNKNOWN",
    orderTypes,
    fillingModes: raw.fillingModes,
    tradingSessions: raw.tradeSessions ?? null,
    verifiedAt,
  };
}

export function normalizeQuote(
  input: unknown,
  accountId: string,
  symbol: string,
  instrumentId: string,
  receivedAt: string,
) {
  const raw = parse(z.object({ symbol: text, bid: numeric, ask: numeric, time }), input);
  if (raw.symbol !== symbol) throw new BrokerProviderError("INVALID_RESPONSE");
  return parse(BrokerQuoteSchema, {
    version: 1,
    provider: "metaapi",
    accountId,
    instrumentId,
    brokerSymbol: symbol,
    bid: raw.bid,
    ask: raw.ask,
    sourceTime: raw.time,
    receivedAt,
    revision: revision([accountId, symbol, raw.time, raw.bid, raw.ask]),
  });
}

export const METAAPI_TIMEFRAMES = [
  "1m",
  "2m",
  "3m",
  "4m",
  "5m",
  "6m",
  "10m",
  "12m",
  "15m",
  "20m",
  "30m",
  "1h",
  "2h",
  "3h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "1w",
  "1mn",
] as const;
export function normalizeCandles(
  input: unknown,
  accountId: string,
  symbol: string,
  instrumentId: string,
  timeframe: string,
  fetchedAt: string,
) {
  if (!METAAPI_TIMEFRAMES.some((value) => value === timeframe))
    throw new BrokerProviderError("INVALID_REQUEST");
  const candles = parse(
    z
      .array(
        z.object({
          symbol: text,
          timeframe: text,
          time,
          open: numeric,
          high: numeric,
          low: numeric,
          close: numeric,
          tickVolume: numeric.nullish(),
          volume: numeric.nullish(),
        }),
      )
      .max(1000),
    input,
  );
  const byTime = new Map<string, ReturnType<typeof BrokerCandleSchema.parse>>();
  for (const raw of candles) {
    if (raw.symbol !== symbol || raw.timeframe !== timeframe)
      throw new BrokerProviderError("INVALID_RESPONSE");
    const end = new Date(raw.time);
    if (timeframe === "1mn") end.setUTCMonth(end.getUTCMonth() + 1);
    else {
      const units = timeframe.endsWith("m")
        ? 60000
        : timeframe.endsWith("h")
          ? 3600000
          : timeframe.endsWith("d")
            ? 86400000
            : 604800000;
      end.setTime(end.getTime() + Number.parseInt(timeframe, 10) * units);
    }
    const candle = parse(BrokerCandleSchema, {
      version: 1,
      provider: "metaapi",
      accountId,
      instrumentId,
      brokerSymbol: symbol,
      timeframe,
      openTime: raw.time,
      open: raw.open,
      high: raw.high,
      low: raw.low,
      close: raw.close,
      volume: raw.tickVolume ?? raw.volume ?? null,
      complete: end.getTime() <= new Date(fetchedAt).getTime(),
      fetchedAt,
      revision: revision([
        accountId,
        symbol,
        timeframe,
        raw.time,
        raw.open,
        raw.high,
        raw.low,
        raw.close,
        raw.tickVolume,
      ]),
    });
    byTime.set(candle.openTime, candle);
  }
  return [...byTime.values()].sort((a, b) => a.openTime.localeCompare(b.openTime));
}

/** Trusted SDK wire boundary. A numeric round-trip must preserve the exact decimal text. */
export function normalizeBrokerDecimal(input: unknown): string {
  return parse(numeric, input);
}
export function brokerSdkNumber(input: string): number {
  const canonical = TradingDecimalSchema.parse(input);
  const number = Number(canonical);
  if (!Number.isFinite(number) || normalizeBrokerDecimal(number) !== canonical)
    throw new BrokerProviderError("INVALID_REQUEST");
  return number;
}
