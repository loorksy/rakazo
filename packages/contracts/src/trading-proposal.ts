import { z } from "zod";
import { TradingMandateEnvelopeSchema } from "./financial-risk.js";
import { FinancialActionSchema, TradingDecimalSchema } from "./trading.js";

const Id = z.string().min(1).max(128);
export const TradeExecuteCommandSchema = z.strictObject({ proposalId: Id, previewId: Id });
export const TradeReconcileCommandSchema = z.strictObject({ effectId: Id });
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Refs = z.array(Id).max(128);
export const TradePrepareCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    mandateId: Id,
    planId: Id,
    action: FinancialActionSchema,
    rationaleSummary: z.string().trim().min(1).max(2000),
    evidenceRefs: Refs,
    chartRefs: Refs,
  }),
  z.strictObject({ operation: z.literal("get"), proposalId: Id }),
  z.strictObject({ operation: z.literal("list"), mandateId: Id }),
  z.strictObject({
    operation: z.literal("preview"),
    proposalId: Id,
    expectedRevision: z.number().int().positive(),
  }),
]);
export const FinancialRiskAssessmentSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("DENY"), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }),
  z.strictObject({
    decision: z.literal("ALLOW"),
    calculationVersion: z.literal("stop-loss-v1"),
    riskBefore: TradingDecimalSchema,
    riskAfter: TradingDecimalSchema,
    incrementalRisk: TradingDecimalSchema,
    notional: TradingDecimalSchema,
    margin: TradingDecimalSchema,
    classification: z.enum(["REDUCES_RISK", "SAME_RISK", "INCREASES_RISK"]),
  }),
]);
export const TradePreviewViewSchema = z.strictObject({
  id: Id,
  proposalId: Id,
  version: z.number().int().positive(),
  actionFingerprint: Hash,
  action: FinancialActionSchema,
  risk: FinancialRiskAssessmentSchema,
  observedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  authorizationGranted: z.literal(false),
});
export const TradeProposalViewSchema = z.strictObject({
  id: Id,
  goalId: Id,
  mandateId: Id,
  planId: Id,
  planVersion: z.number().int().positive(),
  action: FinancialActionSchema,
  actionFingerprint: Hash,
  rationaleSummary: z.string(),
  evidenceRefs: Refs,
  chartRefs: Refs,
  revision: z.number().int().positive(),
  status: z.enum(["DRAFT", "PREVIEWED", "BLOCKED"]),
  preview: TradePreviewViewSchema.nullable(),
});
export const TradePrepareResponseSchema = z.union([
  TradeProposalViewSchema,
  z.array(TradeProposalViewSchema).max(100),
]);
export type TradeProposalView = z.infer<typeof TradeProposalViewSchema>;
export type TradePreviewView = z.infer<typeof TradePreviewViewSchema>;

export const FinancialReviewContextSchema = z.strictObject({
  version: z.literal(1),
  policyVersion: z.literal("financial-v1"),
  action: FinancialActionSchema,
  actionFingerprint: Hash,
  mandateId: Id,
  mandateFingerprint: Hash,
  mandateState: z
    .strictObject({
      status: z.string().min(1).max(64),
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
  envelope: TradingMandateEnvelopeSchema,
  planVersion: z.number().int().positive(),
  risk: FinancialRiskAssessmentSchema,
  observedAt: z.iso.datetime({ offset: true }),
  rationaleSummary: z.string().trim().min(1).max(2000),
  evidenceRefs: Refs,
  chartRefs: Refs,
});
export type FinancialReviewContext = z.infer<typeof FinancialReviewContextSchema>;
