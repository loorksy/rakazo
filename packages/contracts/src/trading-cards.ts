import { z } from "zod";

const Id = z.string().min(1).max(128);
const Text = z.string().max(240);
const Price = z.string().max(32);
const Market = z.strictObject({
  accountId: Id,
  instrumentId: Id,
  brokerSymbol: z.string().min(1).max(64),
  provider: z.string().min(1).max(32),
});

const recommendation = z.strictObject({
  type: z.literal("RECOMMENDATION"),
  market: Market,
  side: z.enum(["BUY", "SELL", "WAIT"]),
  timeframe: z.string().min(1).max(8),
  currentPrice: Price.nullable(),
  entry: Price.nullable(),
  stopLoss: Price.nullable(),
  target: Price.nullable(),
  riskReward: z.string().max(16).nullable(),
  status: z.enum([
    "DRAFT",
    "ACTIVE",
    "WAITING_ENTRY",
    "TRIGGERED",
    "INVALIDATED",
    "EXPIRED",
    "EXECUTED",
  ]),
  freshness: z.string().max(40),
  positionSize: z.null(),
  reportTitle: z.string().max(120).optional(),
});

const summary = z.strictObject({
  type: z.literal("SUMMARY"),
  market: Market.nullable(),
  title: Text,
  body: z.string().max(600),
});
const livePrice = z.strictObject({
  type: z.literal("LIVE_PRICE"),
  market: Market,
  bid: Price.nullable(),
  ask: Price.nullable(),
  freshness: z.string().max(40),
});
const location = z.strictObject({
  type: z.literal("PRICE_LOCATION"),
  market: Market,
  currentPrice: Price.nullable(),
  note: z.string().max(400),
});
const target = z.strictObject({
  type: z.literal("TARGET"),
  market: Market,
  target: Price,
  invalidation: Price.nullable(),
});
const plan = z.strictObject({
  type: z.literal("PLAN"),
  market: Market,
  summary: z.string().max(600),
});
const risk = z.strictObject({
  type: z.literal("RISK"),
  market: Market,
  note: z.string().max(400),
  positionSize: z.null(),
});
const news = z.strictObject({
  type: z.literal("NEWS"),
  market: Market.nullable(),
  note: z.string().max(600),
  configured: z.boolean(),
});
const chart = z.strictObject({
  type: z.literal("CHART"),
  market: Market,
  timeframe: z.string().min(1).max(8),
});
const approval = z.strictObject({
  type: z.literal("EXECUTION_APPROVAL"),
  market: Market,
  side: z.enum(["BUY", "SELL", "WAIT"]),
  note: z.string().max(240),
});
const preview = z.strictObject({
  type: z.literal("EXECUTION_PREVIEW"),
  market: Market,
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT", "STOP"]),
  entry: Price.nullable(),
  stopLoss: Price.nullable(),
  target: Price.nullable(),
  volume: Price,
  estimatedLoss: Price.nullable(),
  estimatedProfit: Price.nullable(),
  environment: z.enum(["DEMO", "REAL"]).nullable(),
  mode: z.enum(["SIMULATION", "LIVE"]),
  fingerprint: z.string().min(4).max(32),
  executable: z.literal(false),
});
const position = z.strictObject({
  type: z.literal("OPEN_POSITION"),
  market: Market,
  side: z.enum(["BUY", "SELL"]),
  entry: Price.nullable(),
  currentPrice: Price.nullable(),
  stopLoss: Price.nullable(),
  target: Price.nullable(),
  status: Text,
});
const pending = z.strictObject({
  type: z.literal("PENDING_ORDER"),
  market: Market,
  side: z.enum(["BUY", "SELL"]),
  price: Price.nullable(),
  status: Text,
});
const monitoring = z.strictObject({
  type: z.literal("MONITORING"),
  market: Market,
  note: z.string().max(400),
});
const alert = z.strictObject({
  type: z.literal("ALERT"),
  market: Market,
  note: z.string().max(400),
});
const result = z.strictObject({
  type: z.literal("RESULT"),
  market: Market,
  outcome: Text,
});
const report = z.strictObject({
  type: z.literal("REPORT"),
  market: Market,
  title: z.string().min(1).max(120),
  sections: z
    .array(z.strictObject({ heading: z.string().min(1).max(80), body: z.string().max(2000) }))
    .max(12),
});
const account = z.strictObject({
  type: z.literal("ACCOUNT_STATUS"),
  accountId: Id,
  label: z.string().max(80),
  environment: z.enum(["DEMO", "REAL"]).nullable(),
  connected: z.boolean(),
  accountRead: z.boolean(),
  execution: z.enum(["NONE", "MANDATE"]),
});
const context = z.strictObject({
  type: z.literal("MARKET_CONTEXT"),
  market: Market,
  note: z.string().max(400),
});
const authority = z.strictObject({
  type: z.literal("AUTHORITY"),
  marketData: z.literal(true),
  accountRead: z.boolean(),
  execution: z.enum(["NONE", "MANDATE"]),
  note: z.string().max(240),
});
const status = z.strictObject({
  type: z.literal("STATUS"),
  market: Market.nullable(),
  note: z.string().max(400),
});

export const TradingCardSchema = z.discriminatedUnion("type", [
  recommendation,
  summary,
  livePrice,
  location,
  target,
  plan,
  risk,
  news,
  chart,
  approval,
  preview,
  position,
  pending,
  monitoring,
  alert,
  result,
  report,
  account,
  context,
  authority,
  status,
]);
export type TradingCard = z.infer<typeof TradingCardSchema>;

export const TradingPresentationSchema = z.strictObject({
  text: z.string().trim().min(1).max(700),
  cards: z.array(TradingCardSchema).max(3),
});
export type TradingPresentation = z.infer<typeof TradingPresentationSchema>;

export const TRADING_CARD_TYPES = [
  "RECOMMENDATION",
  "SUMMARY",
  "LIVE_PRICE",
  "PRICE_LOCATION",
  "TARGET",
  "PLAN",
  "RISK",
  "NEWS",
  "CHART",
  "EXECUTION_APPROVAL",
  "EXECUTION_PREVIEW",
  "OPEN_POSITION",
  "PENDING_ORDER",
  "MONITORING",
  "ALERT",
  "RESULT",
  "REPORT",
  "ACCOUNT_STATUS",
  "MARKET_CONTEXT",
  "AUTHORITY",
  "STATUS",
] as const;
