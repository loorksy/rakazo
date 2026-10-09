import { z } from "zod";

/** Decimal text is the financial wire format; never coerce it through Number. */
export const TradingDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/)
  .transform((value) => value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));

export const PositiveTradingDecimalSchema = TradingDecimalSchema.refine(
  (value) => value !== "0",
  "A positive value is required",
);

/** Both operands have already passed the bounded decimal schema. */
function decimalUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
}

export const TradingModeSchema = z.enum(["SIMULATION", "LIVE"]);
export const BrokerEnvironmentSchema = z.enum(["DEMO", "REAL"]);
export const TradingOperationSchema = z.enum([
  "OPEN",
  "MODIFY_ORDER",
  "CANCEL_ORDER",
  "MODIFY_PROTECTION",
  "CLOSE_POSITION",
]);
const Reference = z.string().min(1).max(128);
const BrokerSymbol = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "Control characters are not valid broker symbols",
  );
const Timestamp = z.iso.datetime({ offset: true });
const protection = {
  stopLoss: PositiveTradingDecimalSchema.nullable(),
  takeProfit: PositiveTradingDecimalSchema.nullable(),
};
const identity = {
  version: z.literal(1),
  mode: TradingModeSchema,
  provider: Reference,
  accountId: Reference,
  instrumentId: Reference,
  brokerSymbol: BrokerSymbol,
};

/** Final normalized material payload, not a natural-language trade suggestion. */
export const FinancialActionSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      ...identity,
      operation: z.literal("OPEN"),
      side: z.enum(["BUY", "SELL"]),
      orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]),
      volume: PositiveTradingDecimalSchema,
      price: PositiveTradingDecimalSchema.nullable(),
      stopLimitPrice: PositiveTradingDecimalSchema.nullable(),
      expiresAt: Timestamp.nullable(),
      fillingMode: Reference.nullable(),
      ...protection,
    }),
    z.strictObject({
      ...identity,
      operation: z.literal("MODIFY_ORDER"),
      orderId: Reference,
      volume: PositiveTradingDecimalSchema,
      price: PositiveTradingDecimalSchema,
      stopLimitPrice: PositiveTradingDecimalSchema.nullable(),
      expiresAt: Timestamp.nullable(),
      ...protection,
    }),
    z.strictObject({ ...identity, operation: z.literal("CANCEL_ORDER"), orderId: Reference }),
    z.strictObject({
      ...identity,
      operation: z.literal("MODIFY_PROTECTION"),
      positionId: Reference,
      ...protection,
    }),
    z.strictObject({
      ...identity,
      operation: z.literal("CLOSE_POSITION"),
      positionId: Reference,
      /** null means full close; the provider must resolve and validate current volume. */
      volume: PositiveTradingDecimalSchema.nullable(),
    }),
  ])
  .superRefine((action, context) => {
    if (action.operation !== "OPEN") return;
    if ((action.orderType === "MARKET") !== (action.price === null)) {
      context.addIssue({
        code: "custom",
        path: ["price"],
        message: "Only market orders omit a requested price",
      });
    }
    if ((action.orderType === "STOP_LIMIT") !== (action.stopLimitPrice !== null)) {
      context.addIssue({
        code: "custom",
        path: ["stopLimitPrice"],
        message: "Stop-limit price must match the order type",
      });
    }
    if (action.orderType === "MARKET" && action.expiresAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A market order cannot have pending-order expiration",
      });
    }
  });

export type FinancialAction = z.infer<typeof FinancialActionSchema>;
export type TradingMode = z.infer<typeof TradingModeSchema>;

export const TradingAuthorityEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  ownerId: Reference,
  botId: Reference,
  accountId: Reference,
  mode: TradingModeSchema,
  expiresAt: Timestamp,
  allowedInstruments: z.array(Reference).min(1).max(256),
  allowedOperations: z.array(TradingOperationSchema).min(1),
  maxMissionLoss: PositiveTradingDecimalSchema,
  maxOpenRisk: PositiveTradingDecimalSchema,
  maxRiskPerTrade: PositiveTradingDecimalSchema,
  maxConcurrentPositions: z.number().int().min(1).max(100),
  maxPendingOrders: z.number().int().min(0).max(100),
  breachBehavior: z.enum(["FREEZE", "CANCEL_PENDING", "CLOSE_ATTRIBUTED_EXPOSURE"]),
  expiryBehavior: z.enum(["FREEZE", "CANCEL_PENDING", "CLOSE_ATTRIBUTED_EXPOSURE"]),
});

/** Capability claims are discovered from a provider, never inferred from tool names. */
export const TradingCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  provider: Reference,
  accountId: Reference,
  environment: BrokerEnvironmentSchema,
  accountMode: z.enum(["HEDGING", "NETTING", "UNKNOWN"]),
  quotes: z.boolean(),
  quoteStreaming: z.boolean(),
  candles: z.boolean(),
  historicalCandles: z.boolean(),
  accountEvents: z.boolean(),
  accountRead: z.boolean(),
  positionsRead: z.boolean(),
  ordersRead: z.boolean(),
  symbolSpecifications: z.boolean(),
  operations: z.array(TradingOperationSchema),
  orderTypes: z.array(z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"])),
  partialClose: z.boolean(),
  protectiveStops: z.boolean(),
  nativeOco: z.boolean(),
  clientReferences: z.boolean(),
  verifiedAt: Timestamp,
  revision: Reference,
});

export const BrokerQuoteSchema = z
  .strictObject({
    version: z.literal(1),
    provider: Reference,
    accountId: Reference,
    instrumentId: Reference,
    brokerSymbol: BrokerSymbol,
    bid: PositiveTradingDecimalSchema,
    ask: PositiveTradingDecimalSchema,
    sourceTime: Timestamp,
    receivedAt: Timestamp,
    revision: Reference,
  })
  .superRefine((quote, context) => {
    if (decimalUnits(quote.ask) < decimalUnits(quote.bid)) {
      context.addIssue({ code: "custom", path: ["ask"], message: "Ask cannot be below bid" });
    }
  });

export const BrokerCandleSchema = z
  .strictObject({
    version: z.literal(1),
    provider: Reference,
    accountId: Reference,
    instrumentId: Reference,
    brokerSymbol: BrokerSymbol,
    timeframe: Reference,
    /** Candle opening time in UTC, not collection or completion time. */
    openTime: Timestamp,
    open: PositiveTradingDecimalSchema,
    high: PositiveTradingDecimalSchema,
    low: PositiveTradingDecimalSchema,
    close: PositiveTradingDecimalSchema,
    volume: TradingDecimalSchema.nullable(),
    complete: z.boolean(),
    fetchedAt: Timestamp,
    revision: Reference,
  })
  .superRefine((candle, context) => {
    const high = decimalUnits(candle.high);
    const low = decimalUnits(candle.low);
    if (high < low || decimalUnits(candle.open) > high || decimalUnits(candle.close) > high) {
      context.addIssue({ code: "custom", path: ["high"], message: "Invalid candle upper bound" });
    }
    if (decimalUnits(candle.open) < low || decimalUnits(candle.close) < low) {
      context.addIssue({ code: "custom", path: ["low"], message: "Invalid candle lower bound" });
    }
  });

export type TradingCapabilities = z.infer<typeof TradingCapabilitiesSchema>;
export type BrokerQuote = z.infer<typeof BrokerQuoteSchema>;
export type BrokerCandle = z.infer<typeof BrokerCandleSchema>;

export const TradingConnectionViewSchema = z.strictObject({
  id: Reference,
  label: z.string().max(80),
  provider: z.literal("metaapi"),
  providerAccountId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  region: Reference.nullable(),
  environment: BrokerEnvironmentSchema.nullable(),
  verifiedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  state: z.enum(["DISCONNECTED", "CONNECTING", "CONNECTED", "RECONNECTING"]),
  lastHealthyAt: Timestamp.nullable(),
  failureCode: z.string().nullable(),
});

export const TradingConnectionInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  providerAccountId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  region: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  token: z.string().min(1).max(16384),
});
export type TradingConnectionView = z.infer<typeof TradingConnectionViewSchema>;
export const BrokerLiveEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("quote"), quote: BrokerQuoteSchema }),
  z.strictObject({
    type: z.literal("account_changed"),
    accountId: Reference,
    kind: Reference,
    reference: Reference.nullable(),
    receivedAt: Timestamp,
  }),
  z.strictObject({
    type: z.literal("connection_changed"),
    accountId: Reference,
    connected: z.boolean(),
    receivedAt: Timestamp,
  }),
]);
export const BrokerLivePacketSchema = z.strictObject({
  generation: z.number().int().positive(),
  events: z.array(BrokerLiveEventSchema).max(16),
});

const brokerReadIdentity = { accountId: Reference };
const instrumentRead = { ...brokerReadIdentity, instrumentId: Reference };
export const BrokerReadCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...brokerReadIdentity, operation: z.literal("account") }),
  z.strictObject({ ...brokerReadIdentity, operation: z.literal("positions") }),
  z.strictObject({ ...brokerReadIdentity, operation: z.literal("orders") }),
  z.strictObject({ ...brokerReadIdentity, operation: z.literal("instruments") }),
  z.strictObject({ ...brokerReadIdentity, operation: z.literal("capabilities") }),
  z.strictObject({ ...instrumentRead, operation: z.literal("specification") }),
  z.strictObject({ ...instrumentRead, operation: z.literal("quote") }),
  z.strictObject({
    ...instrumentRead,
    operation: z.literal("candles"),
    timeframe: Reference,
    before: Timestamp.optional(),
    limit: z.number().int().min(1).max(1000),
  }),
]);
export type BrokerReadCommand = z.infer<typeof BrokerReadCommandSchema>;

export const BrokerInstrumentDirectorySchema = z
  .array(
    z.strictObject({
      id: Reference,
      accountId: Reference,
      brokerSymbol: BrokerSymbol,
      displayName: z.string().max(256),
      verifiedAt: Timestamp.nullable(),
    }),
  )
  .max(10000);
export type BrokerInstrumentDirectory = z.infer<typeof BrokerInstrumentDirectorySchema>;
