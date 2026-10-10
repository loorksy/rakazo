import { z } from "zod";
import { TradingMandateEnvelopeSchema } from "./financial-risk.js";
import { PositiveTradingDecimalSchema, TradingModeSchema } from "./trading.js";

const Id = z.string().min(1).max(128);
const Time = z.iso.datetime({ offset: true });
const Refs = z.array(Id).max(128);
/** Scope identity is injected from the claimed Bot/goal, never selected by the model. */
export const TradingMandateDraftSchema = z
  .strictObject(TradingMandateEnvelopeSchema.shape)
  .omit({ ownerId: true, botId: true, accountId: true, mode: true });
export const TradingGoalInputSchema = z
  .strictObject({
    version: z.literal(1),
    accountId: Id,
    mode: TradingModeSchema,
    objectiveType: z.enum(["ATTEMPT_PROFIT", "POSITION_SUPERVISION"]),
    targetProfit: PositiveTradingDecimalSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    startsAt: Time,
    endsAt: Time,
    allowedInstruments: z.array(Id).max(256),
    userObjective: z.string().trim().min(1).max(4000),
    positionId: Id.nullable(),
  })
  .superRefine((goal, context) => {
    if (Date.parse(goal.endsAt) <= Date.parse(goal.startsAt))
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Goal requires an ordered time window",
      });
    if ((goal.objectiveType === "POSITION_SUPERVISION") !== (goal.positionId !== null))
      context.addIssue({
        code: "custom",
        path: ["positionId"],
        message: "Supervision requires the exact broker position",
      });
  });
export type TradingGoalInput = z.infer<typeof TradingGoalInputSchema>;
export const TradingPlanInputSchema = z.strictObject({
  version: z.literal(1),
  summary: z.string().trim().min(1).max(2000),
  marketScope: z.array(Id).min(1).max(256),
  monitoring: z.strictObject({ watchIds: Refs, reevaluationAt: z.array(Time).max(32) }),
  executionApproach: z.string().trim().min(1).max(2000),
  riskProposal: TradingMandateDraftSchema,
  evidenceRefs: Refs,
  chartRefs: Refs,
});
export type TradingPlanInput = z.infer<typeof TradingPlanInputSchema>;
export const TradingMissionCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ botId: Id.optional(), operation: z.literal("list") }),
  z.strictObject({
    botId: Id.optional(),
    operation: z.literal("goal_create"),
    goal: TradingGoalInputSchema,
  }),
  z.strictObject({
    botId: Id.optional(),
    operation: z.literal("plan_create"),
    goalId: Id,
    expectedVersion: z.number().int().min(0),
    plan: TradingPlanInputSchema,
  }),
  z.strictObject({ botId: Id.optional(), operation: z.literal("mandate_propose"), planId: Id }),
  z.strictObject({ botId: Id.optional(), operation: z.literal("get"), goalId: Id }),
]);
/** Authenticated human RPC only. No matching Bot tool exists. */
export const MandateResolutionSchema = z.strictObject({
  id: Id,
  expectedRevision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  approve: z.boolean(),
});
export const MandateControlSchema = z.strictObject({
  id: Id,
  expectedRevision: z.number().int().positive(),
  action: z.enum(["PAUSE", "CANCEL", "EMERGENCY_STOP", "RESUME"]),
});

export const TradingGoalViewSchema = z.strictObject({
  id: Id,
  goal: TradingGoalInputSchema,
  status: z.string().max(64),
  targetGuaranteed: z.literal(false),
});
export const TradingPlanViewSchema = z.strictObject({
  id: Id,
  goalId: Id,
  version: z.number().int().positive(),
  plan: TradingPlanInputSchema,
});
export const TradingMandateViewSchema = z.strictObject({
  id: Id,
  goalId: Id,
  planId: Id,
  status: z.string().max(64),
  revision: z.number().int().positive(),
  envelope: TradingMandateEnvelopeSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  approvedAt: Time.nullable(),
  missionPnl: z.string().max(64),
  expiresAt: Time,
});
export const TradingMissionDetailSchema = z.strictObject({
  goal: TradingGoalViewSchema,
  plans: z.array(TradingPlanViewSchema).max(64),
  mandates: z.array(TradingMandateViewSchema).max(64),
});
export const TradingMissionResponseSchema = z.union([
  TradingGoalViewSchema,
  z.array(TradingGoalViewSchema).max(100),
  TradingPlanViewSchema,
  TradingMandateViewSchema,
  TradingMissionDetailSchema,
]);
export type TradingGoalView = z.infer<typeof TradingGoalViewSchema>;
export type TradingPlanView = z.infer<typeof TradingPlanViewSchema>;
export type TradingMandateView = z.infer<typeof TradingMandateViewSchema>;
export type TradingMissionResponse = z.infer<typeof TradingMissionResponseSchema>;
export type TradingMissionDetail = z.infer<typeof TradingMissionDetailSchema>;
