import type { FinancialEffectContext } from "@rakazo/contracts";
import {
  FinancialActionSchema,
  FinancialEffectContextSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { mandateActionAuthority } from "@rakazo/core";
import {
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import type { Prisma } from "./client.js";

type Effect = Prisma.ExternalEffectGetPayload<Record<never, never>>;

/** Validation only; admission later rechecks account freeze, fresh facts and risk under its lock. */
export async function validateFinancialApproval(
  tx: Prisma.TransactionClient,
  effect: Effect,
  input: { userId: string; botId: string; spaceId: string; answer: string },
  now: Date,
): Promise<FinancialEffectContext | null> {
  const parsed = FinancialEffectContextSchema.safeParse(effect.financialContext);
  if (!parsed.success || parsed.data.version !== 2) return null;
  const context = parsed.data;
  if (
    !["allow", "deny"].includes(input.answer) ||
    context.ownerUserId !== input.userId ||
    context.botId !== input.botId ||
    effect.status !== "intended" ||
    effect.financialStartedAt ||
    effect.financialApprovedAt ||
    !effect.financialExpiresAt ||
    effect.financialExpiresAt <= now ||
    !["ask", "error"].includes(effect.reviewDecision ?? "")
  )
    return null;
  try {
    if (financialActionFingerprint(effect.request) !== context.actionFingerprint) return null;
  } catch {
    return null;
  }
  const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
  if (
    !settings?.singleOwnerEnforced ||
    settings.ownerUserId !== input.userId ||
    settings.ownerSpaceId !== input.spaceId
  )
    return null;
  if (
    !(await tx.bot.findFirst({
      where: {
        id: input.botId,
        userId: input.userId,
        spaceId: input.spaceId,
      },
    }))
  )
    return null;
  const proposal = await tx.tradeProposal.findUnique({ where: { id: context.proposalId } });
  if (
    !proposal ||
    proposal.ownerUserId !== input.userId ||
    proposal.botId !== input.botId ||
    proposal.accountId !== context.accountId ||
    proposal.mode !== context.mode ||
    proposal.mandateId !== context.authorizationId ||
    proposal.goalId !== context.goalId ||
    proposal.planId !== context.planId ||
    proposal.planVersion !== context.planVersion ||
    proposal.actionFingerprint !== context.actionFingerprint
  )
    return null;
  const mandate = await tx.tradingMandate.findUnique({ where: { id: context.authorizationId } });
  const envelope = TradingMandateEnvelopeSchema.safeParse(mandate?.envelope);
  if (
    !mandate ||
    !envelope.success ||
    mandate.ownerUserId !== input.userId ||
    mandate.botId !== input.botId ||
    mandate.accountId !== context.accountId ||
    mandate.mode !== context.mode ||
    mandate.goalId !== context.goalId ||
    mandate.expiresAt.getTime() !== Date.parse(envelope.data.expiresAt) ||
    envelope.data.ownerId !== input.userId ||
    envelope.data.botId !== input.botId ||
    envelope.data.accountId !== context.accountId ||
    envelope.data.mode !== context.mode ||
    mandate.approvedByUserId !== input.userId ||
    !mandate.approvedAt ||
    mandate.fingerprint !== tradingMandateFingerprint(envelope.data) ||
    mandate.approvedFingerprint !== mandate.fingerprint
  )
    return null;
  if (input.answer === "allow") {
    const goal = await tx.tradingGoal.findUnique({ where: { id: mandate.goalId } });
    const definition = TradingGoalInputSchema.safeParse(goal?.definition);
    const action = FinancialActionSchema.safeParse(effect.request);
    if (
      !goal ||
      !definition.success ||
      !action.success ||
      goal.ownerUserId !== input.userId ||
      goal.botId !== input.botId ||
      goal.accountId !== context.accountId ||
      goal.mode !== context.mode ||
      !mandateActionAuthority({
        status: mandate.status,
        envelope: envelope.data,
        action: action.data,
        startsAt: definition.data.startsAt,
        endsAt: definition.data.endsAt,
        now,
      })
    )
      return null;
  }
  return context;
}
