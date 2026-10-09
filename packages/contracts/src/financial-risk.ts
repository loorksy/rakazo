import { z } from "zod";
import {
  BrokerQuoteSchema,
  PositiveTradingDecimalSchema,
  TradingAuthorityEnvelopeSchema,
  TradingDecimalSchema,
} from "./trading.js";

const Id = z.string().min(1).max(128);
const Time = z.iso.datetime({ offset: true });
export const SignedTradingDecimalSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/)
  .transform((value) => {
    const negative = value.startsWith("-");
    const normalized = TradingDecimalSchema.parse(negative ? value.slice(1) : value);
    return negative && normalized !== "0" ? `-${normalized}` : normalized;
  });
/** Only the owner approves this final envelope. Allocation is accounting, not segregation. */
export const TradingMandateEnvelopeSchema = TradingAuthorityEnvelopeSchema.extend({
  currency: z.string().regex(/^[A-Z]{3}$/),
  allocatedCapital: PositiveTradingDecimalSchema,
  maxNotional: PositiveTradingDecimalSchema,
  maxMarginUsagePercent: PositiveTradingDecimalSchema,
  maxDailyLoss: PositiveTradingDecimalSchema.nullable(),
  allowedOrderTypes: z
    .array(z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]))
    .min(1)
    .max(4),
  riskIncreasePermissions: z
    .array(z.enum(["WIDEN_STOP", "ADD_EXPOSURE", "HEDGE", "INCREASE_PENDING_VOLUME"]))
    .max(4),
  supervisionPositionId: Id.nullable(),
  supervisedOrderIds: z.array(Id).max(100),
  targetBehavior: z.enum(["FREEZE", "CANCEL_PENDING", "CLOSE_ATTRIBUTED_EXPOSURE"]),
  riskCalculationVersion: z.literal("stop-loss-v1"),
  costReservePerTrade: TradingDecimalSchema,
}).superRefine((envelope, context) => {
  if (Number(envelope.maxMarginUsagePercent) > 100)
    context.addIssue({
      code: "custom",
      path: ["maxMarginUsagePercent"],
      message: "Margin percentage cannot exceed 100",
    });
});
export type TradingMandateEnvelope = z.infer<typeof TradingMandateEnvelopeSchema>;

/** Trusted provider snapshot. Never accept this structure as a model-supplied risk claim. */
export const FinancialRiskFactsSchema = z.strictObject({
  version: z.literal(1),
  /** Trusted simulation preflight pins the virtual book revision; never a tool argument. */
  simulationRevision: z.number().int().positive().optional(),
  accountId: Id,
  instrumentId: Id,
  brokerSymbol: Id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  connected: z.boolean(),
  tradingAllowed: z.boolean(),
  accountMode: z.enum(["HEDGING", "NETTING", "UNKNOWN"]),
  observedAt: Time,
  equity: SignedTradingDecimalSchema,
  freeMargin: SignedTradingDecimalSchema,
  margin: TradingDecimalSchema,
  quote: BrokerQuoteSchema,
  tickSize: PositiveTradingDecimalSchema,
  lossTickValue: PositiveTradingDecimalSchema.nullable(),
  contractSize: PositiveTradingDecimalSchema.nullable(),
  profitCurrency: z.string().nullable(),
  minVolume: PositiveTradingDecimalSchema,
  maxVolume: PositiveTradingDecimalSchema,
  volumeStep: PositiveTradingDecimalSchema,
  digits: z.number().int().min(0).max(12),
  stopsLevel: z.number().int().min(0).max(1000000),
  symbolTradingAllowed: z.boolean(),
  specificationObservedAt: Time,
  orderTypes: z.array(z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"])).max(4),
  partialClose: z.boolean(),
  proposedMargin: TradingDecimalSchema.nullable(),
  openPositions: z
    .array(
      z.strictObject({
        id: Id,
        symbol: Id,
        side: z.enum(["BUY", "SELL"]),
        volume: PositiveTradingDecimalSchema,
      }),
    )
    .max(1000),
  pendingOrders: z
    .array(
      z.strictObject({
        id: Id,
        symbol: Id,
        side: z.enum(["BUY", "SELL"]),
        volume: PositiveTradingDecimalSchema,
      }),
    )
    .max(1000),
});
export type FinancialRiskFacts = z.infer<typeof FinancialRiskFactsSchema>;
export const FinancialRiskTargetSchema = z.strictObject({
  id: Id,
  kind: z.enum(["POSITION", "ORDER"]),
  orderType: z.enum(["LIMIT", "STOP", "STOP_LIMIT"]).nullable(),
  instrumentId: Id,
  brokerSymbol: Id,
  side: z.enum(["BUY", "SELL"]),
  volume: PositiveTradingDecimalSchema,
  entry: PositiveTradingDecimalSchema,
  stopLoss: PositiveTradingDecimalSchema.nullable(),
  takeProfit: PositiveTradingDecimalSchema.nullable(),
  attributed: z.boolean(),
  drifted: z.boolean(),
  observedAt: Time,
});
export type FinancialRiskTarget = z.infer<typeof FinancialRiskTargetSchema>;
export const FinancialRiskStateSchema = z.strictObject({
  version: z.literal(1),
  missionPnl: SignedTradingDecimalSchema,
  dailyPnl: SignedTradingDecimalSchema,
  openRisk: TradingDecimalSchema,
  openNotional: TradingDecimalSchema,
  positions: z.number().int().min(0).max(1000),
  pendingOrders: z.number().int().min(0).max(1000),
  unresolvedEffects: z.boolean(),
  missionActive: z.boolean(),
  accountFrozen: z.boolean(),
});
export type FinancialRiskState = z.infer<typeof FinancialRiskStateSchema>;

export const AccountRiskGuardrailsSchema = z.strictObject({
  version: z.literal(1),
  accountId: Id,
  mode: z.enum(["SIMULATION", "LIVE"]),
  maxReservedRisk: PositiveTradingDecimalSchema,
  maxExposure: PositiveTradingDecimalSchema,
  maxPendingExposure: TradingDecimalSchema,
  maxActiveMandates: z.number().int().min(1).max(100),
  maxDrawdown: PositiveTradingDecimalSchema.nullable(),
  maxMarginUsagePercent: PositiveTradingDecimalSchema.nullable(),
  autonomousEnabled: z.boolean(),
  frozen: z.boolean(),
  revision: z.number().int().positive(),
});
export type AccountRiskGuardrails = z.infer<typeof AccountRiskGuardrailsSchema>;
