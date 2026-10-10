import { z } from "zod";
import { PositiveTradingDecimalSchema } from "./trading.js";

const Ref = z.string().min(1).max(128);
export const MarketConditionSchema = z.strictObject({
  version: z.literal(1),
  field: z.enum(["BID", "ASK"]),
  comparison: z.enum(["AT_OR_ABOVE", "AT_OR_BELOW", "CROSS_ABOVE", "CROSS_BELOW"]),
  price: PositiveTradingDecimalSchema,
});
export type MarketCondition = z.infer<typeof MarketConditionSchema>;
export const MarketWatchCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({
    operation: z.literal("cancel"),
    id: Ref,
    expectedRevision: z.number().int().positive(),
  }),
  z.strictObject({
    operation: z.literal("create"),
    botId: z.string().min(1).max(128).optional(),
    accountId: Ref,
    instrumentId: Ref,
    condition: MarketConditionSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    summary: z.string().trim().min(1).max(500),
  }),
]);
export type MarketWatchCommand = z.infer<typeof MarketWatchCommandSchema>;
export const MarketWatchSchema = z.strictObject({
  version: z.literal(1),
  id: Ref,
  accountId: Ref,
  instrumentId: Ref,
  botId: Ref,
  condition: MarketConditionSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  summary: z.string(),
  revision: z.number().int().positive(),
  wakeGeneration: z.number().int().nonnegative(),
  status: z.enum(["ACTIVE", "FIRED", "EXPIRED", "CANCELLED", "DELIVERY_NEEDED", "NEEDS_ATTENTION"]),
  lastSourceTime: z.iso.datetime({ offset: true }).nullable(),
  triggeredRunId: Ref.nullable(),
});
export type MarketWatch = z.infer<typeof MarketWatchSchema>;
