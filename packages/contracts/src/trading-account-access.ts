import * as z from "zod";
import { Id } from "./ids.js";

export const TradingAccountAccessViewSchema = z.strictObject({
  botId: Id,
  accountId: Id,
  label: z.string(),
  accountRead: z.boolean(),
  mandateRead: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type TradingAccountAccessView = z.infer<typeof TradingAccountAccessViewSchema>;

export const TradingJournalQuerySchema = z.strictObject({
  accountId: Id.optional(),
  mode: z.enum(["SIMULATION", "LIVE"]).optional(),
  mandateId: Id.optional(),
  effectId: Id.optional(),
  cursor: Id.optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type TradingJournalQuery = z.infer<typeof TradingJournalQuerySchema>;
export const TradingJournalPageSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        id: Id,
        accountId: Id,
        mode: z.enum(["SIMULATION", "LIVE"]),
        effectId: Id.nullable(),
        goalId: Id.nullable(),
        mandateId: Id.nullable(),
        event: z.string(),
        entry: z.json(),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(100),
  nextCursor: Id.nullable(),
});
export type TradingJournalPage = z.infer<typeof TradingJournalPageSchema>;
