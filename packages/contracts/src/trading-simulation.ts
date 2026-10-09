import { z } from "zod";
import { SignedTradingDecimalSchema } from "./financial-risk.js";
import { PositiveTradingDecimalSchema, TradingDecimalSchema } from "./trading.js";

const Id = z.string().min(1).max(128);
const Time = z.iso.datetime({ offset: true });
export const SimulationPositionSchema = z.strictObject({
  id: Id,
  originEffectId: Id,
  mandateId: Id,
  goalId: Id,
  planVersion: z.number().int().positive(),
  instrumentId: Id,
  brokerSymbol: Id,
  side: z.enum(["BUY", "SELL"]),
  volume: PositiveTradingDecimalSchema,
  entry: PositiveTradingDecimalSchema,
  stopLoss: PositiveTradingDecimalSchema.nullable(),
  takeProfit: PositiveTradingDecimalSchema.nullable(),
  contractSize: PositiveTradingDecimalSchema,
  margin: TradingDecimalSchema,
  createdAt: Time,
  updatedAt: Time,
});
export type SimulationPosition = z.infer<typeof SimulationPositionSchema>;
export const SimulationOrderSchema = SimulationPositionSchema.extend({
  orderType: z.enum(["LIMIT", "STOP"]),
  expiresAt: Time,
});
export type SimulationOrder = z.infer<typeof SimulationOrderSchema>;
export const SimulationBookStateSchema = z
  .strictObject({
    version: z.literal(1),
    accountId: Id,
    mode: z.literal("SIMULATION"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    initialEquity: PositiveTradingDecimalSchema,
    balance: SignedTradingDecimalSchema,
    positions: z.array(SimulationPositionSchema).max(1000),
    orders: z.array(SimulationOrderSchema).max(1000),
    performance: z
      .array(
        z.strictObject({
          mandateId: Id,
          realized: SignedTradingDecimalSchema,
          day: z.iso.date(),
          dailyRealized: SignedTradingDecimalSchema,
        }),
      )
      .max(1000),
  })
  .superRefine((state, context) => {
    const exposures = [...state.positions, ...state.orders];
    if (
      new Set(exposures.map((row) => row.id)).size !== exposures.length ||
      new Set(exposures.map((row) => row.originEffectId)).size !== exposures.length ||
      new Set(state.performance.map((row) => row.mandateId)).size !== state.performance.length
    )
      context.addIssue({ code: "custom", message: "Simulation identities must be unique" });
  });
export type SimulationBookState = z.infer<typeof SimulationBookStateSchema>;

/** Provider observations, not new model instructions or broker mutations. */
export const SimulationMarketEventSchema = z.strictObject({
  version: z.literal(1),
  type: z.enum(["ORDER_FILLED", "ORDER_EXPIRED", "STOP_LOSS", "TAKE_PROFIT"]),
  targetId: Id,
  originEffectId: Id,
  mandateId: Id,
  goalId: Id,
  planVersion: z.number().int().positive(),
  instrumentId: Id,
  brokerSymbol: Id,
  price: PositiveTradingDecimalSchema.nullable(),
  pnl: SignedTradingDecimalSchema.nullable(),
  sourceTime: Time,
});
export type SimulationMarketEvent = z.infer<typeof SimulationMarketEventSchema>;
