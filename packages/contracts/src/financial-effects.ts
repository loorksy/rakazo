import { z } from "zod";
import { TradingModeSchema } from "./trading.js";

const Id = z.string().min(1).max(128);
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted execution identity; not accepted from model tool arguments. */
export const FinancialEffectContextSchema = z.strictObject({
  version: z.literal(1),
  ownerUserId: Id,
  botId: Id,
  accountId: Id,
  mode: TradingModeSchema,
  actionFingerprint: Fingerprint,
  authorizationId: Id,
  policyVersion: z.literal("financial-v1"),
});
export type FinancialEffectContext = z.infer<typeof FinancialEffectContextSchema>;
export const FinancialJournalEntrySchema = z.strictObject({
  version: z.literal(1),
  ownerUserId: Id,
  accountId: Id,
  mode: TradingModeSchema,
  effectId: Id,
  event: z.enum([
    "PROPOSED",
    "APPROVED",
    "STARTED",
    "SUCCEEDED",
    "FAILED",
    "UNCERTAIN",
    "RECONCILING",
  ]),
  actionFingerprint: Fingerprint,
  providerReference: Id.nullable(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
});
