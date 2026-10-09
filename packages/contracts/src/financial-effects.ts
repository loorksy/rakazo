import { z } from "zod";
import { TradingModeSchema } from "./trading.js";

const Id = z.string().min(1).max(128);
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
/** Trusted execution identity; not accepted from model tool arguments. */
const FinancialEffectContextV1Schema = z.strictObject({
  version: z.literal(1),
  ownerUserId: Id,
  botId: Id,
  accountId: Id,
  mode: TradingModeSchema,
  actionFingerprint: Fingerprint,
  authorizationId: Id,
  policyVersion: z.literal("financial-v1"),
});
/** v2 adds durable attribution while retaining read compatibility with the audit foundation. */
export const FinancialEffectContextSchema = z.discriminatedUnion("version", [
  FinancialEffectContextV1Schema,
  FinancialEffectContextV1Schema.extend({
    version: z.literal(2),
    proposalId: Id,
    goalId: Id,
    planId: Id,
    planVersion: z.number().int().positive(),
    clientId: z.string().regex(/^rz_[a-f0-9]{10}_[a-f0-9]{10}$/),
  }),
]);
export type FinancialEffectContext = z.infer<typeof FinancialEffectContextSchema>;
export const FinancialEffectOutcomeSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["SUCCEEDED", "FAILED", "UNCERTAIN"]),
  providerReference: Id.nullable(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
});
export type FinancialEffectOutcome = z.infer<typeof FinancialEffectOutcomeSchema>;
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
