import { createHash } from "node:crypto";
import type { AdapterContext, AutoReviewProvider } from "@rakazo/adapter-kit";
import type { FinancialEffectOutcome } from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  FinancialEffectContextSchema,
  FinancialEffectOutcomeSchema,
  FinancialReviewContextSchema,
  FinancialRiskAssessmentSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { mandateActionAuthority } from "@rakazo/core";
import {
  canonicalFinancialAction,
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import { AccountRiskLedger } from "./account-risk-ledger.js";
import type { ChartActor } from "./cloud-charts.js";
import { fenceChartExecution } from "./cloud-charts.js";
import { reviewFinancialAction } from "./financial-review.js";

type Effect = Prisma.ExternalEffectGetPayload<Record<never, never>>;
type FinancialContext = Extract<
  ReturnType<typeof FinancialEffectContextSchema.parse>,
  { version: 2 }
>;
function contextOf(effect: Effect): FinancialContext {
  const context = FinancialEffectContextSchema.parse(effect.financialContext);
  if (context.version !== 2) throw new Error("Attributed financial effect required");
  if (context.actionFingerprint !== financialActionFingerprint(effect.request))
    throw new Error("Effect action binding mismatch");
  return context;
}
/** Protected lifecycle for the existing ExternalEffect table. No broker calls or timer service. */
export class FinancialEffects {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async actor(tx: Prisma.TransactionClient, actor: ChartActor) {
    if (!actor.botId || !actor.execution) throw new Error("Claimed financial execution required");
    await fenceChartExecution(tx, actor);
    const settings = await tx.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
    if (
      !(await tx.bot.findFirst({
        where: {
          id: actor.botId,
          userId: actor.ownerUserId,
          spaceId: settings.ownerSpaceId ?? "",
        },
      }))
    )
      throw new Error("Owner-scoped financial principal required");
    return actor.execution;
  }
  private async owned(
    tx: Prisma.TransactionClient,
    actor: ChartActor,
    id: string,
    accountId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${accountId} FOR UPDATE`;
    const execution = await this.actor(tx, actor);
    await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${id} FOR UPDATE`;
    const effect = await tx.externalEffect.findUniqueOrThrow({ where: { id } });
    const context = contextOf(effect);
    if (
      context.ownerUserId !== actor.ownerUserId ||
      context.botId !== actor.botId ||
      context.accountId !== accountId ||
      effect.runId !== execution.runId ||
      effect.financialRunFence !== execution.generation ||
      effect.financialHolder !== execution.holder
    )
      throw new Error("Stale financial effect ownership");
    return { effect, context, execution };
  }
  async authority(
    tx: Prisma.TransactionClient,
    context: FinancialContext,
    action: ReturnType<typeof canonicalFinancialAction>,
  ) {
    const mandate = await tx.tradingMandate.findUniqueOrThrow({
      where: { id: context.authorizationId },
    });
    const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
    const goalRecord = await tx.tradingGoal.findUniqueOrThrow({ where: { id: context.goalId } });
    const goal = TradingGoalInputSchema.parse(goalRecord.definition);
    const guard = await tx.accountRiskGuardrail.findUnique({
      where: { accountId_mode: { accountId: context.accountId, mode: context.mode } },
    });
    const limits = guard ? AccountRiskGuardrailsSchema.parse(guard.limits) : null;
    const authority = mandateActionAuthority({
      status: mandate.status,
      envelope,
      action,
      startsAt: goal.startsAt,
      endsAt: goal.endsAt,
      now: this.now(),
    });
    if (
      !authority ||
      mandate.ownerUserId !== context.ownerUserId ||
      mandate.botId !== context.botId ||
      mandate.accountId !== context.accountId ||
      mandate.mode !== context.mode ||
      mandate.goalId !== context.goalId ||
      goalRecord.ownerUserId !== context.ownerUserId ||
      goalRecord.botId !== context.botId ||
      goalRecord.accountId !== context.accountId ||
      goalRecord.mode !== context.mode ||
      mandate.expiresAt.getTime() !== Date.parse(envelope.expiresAt) ||
      mandate.approvedByUserId !== context.ownerUserId ||
      !mandate.approvedAt ||
      mandate.approvedFingerprint !== tradingMandateFingerprint(envelope) ||
      mandate.fingerprint !== mandate.approvedFingerprint ||
      envelope.ownerId !== context.ownerUserId ||
      envelope.botId !== context.botId ||
      envelope.accountId !== context.accountId ||
      envelope.mode !== context.mode ||
      !limits?.autonomousEnabled ||
      ((limits.frozen || guard?.frozen) &&
        !(authority === "FINISHING" && mandate.status === "EMERGENCY_STOPPED")) ||
      limits.revision !== guard?.revision ||
      limits.accountId !== context.accountId ||
      limits.mode !== context.mode ||
      guard?.ownerUserId !== context.ownerUserId
    )
      throw new Error("Current bounded financial authority required");
    if (
      !(await tx.tradingConnection.findFirst({
        where: { id: context.accountId, ownerUserId: context.ownerUserId, revokedAt: null },
      }))
    )
      throw new Error("Verified owner account required");
    return { mandate, envelope, authority, goal };
  }
  private journal(
    tx: Prisma.TransactionClient,
    effect: Effect,
    context: FinancialContext,
    event: string,
    entry: Prisma.InputJsonObject,
  ) {
    return tx.financialJournal.create({
      data: {
        ownerUserId: context.ownerUserId,
        accountId: context.accountId,
        mode: context.mode,
        goalId: context.goalId,
        mandateId: context.authorizationId,
        planVersion: context.planVersion,
        effectId: effect.id,
        event,
        entry: {
          version: 1,
          proposalId: context.proposalId,
          actionFingerprint: context.actionFingerprint,
          ...entry,
        },
      },
    });
  }
  async prepare(actor: ChartActor, proposalId: string, previewId: string) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const proposal = await this.prisma.tradeProposal.findFirst({
      where: { id: proposalId, ownerUserId: actor.ownerUserId, botId: actor.botId },
    });
    if (!proposal) throw new Error("Proposal unavailable");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${proposal.accountId} FOR UPDATE`;
      const execution = await this.actor(tx, actor);
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            "financial:v2",
            actor.ownerUserId,
            proposal.accountId,
            proposal.mode,
            proposalId,
          ]),
        )
        .digest("hex");
      const context: FinancialContext = {
        version: 2,
        ownerUserId: actor.ownerUserId,
        botId: proposal.botId,
        accountId: proposal.accountId,
        mode: proposal.mode === "SIMULATION" ? "SIMULATION" : "LIVE",
        authorizationId: proposal.mandateId,
        actionFingerprint: proposal.actionFingerprint,
        policyVersion: "financial-v1",
        proposalId,
        goalId: proposal.goalId,
        planId: proposal.planId,
        planVersion: proposal.planVersion,
        clientId: `rz_${key.slice(0, 10)}_${key.slice(10, 20)}`,
      };
      const prior = await tx.externalEffect.findUnique({ where: { idempotencyKey: key } });
      if (prior) {
        const bound = contextOf(prior);
        if (
          bound.proposalId !== proposalId ||
          bound.actionFingerprint !== context.actionFingerprint ||
          bound.ownerUserId !== actor.ownerUserId ||
          bound.botId !== actor.botId
        )
          throw new Error("Financial effect binding mismatch");
        // Inspect an already started/terminal result even after preview/mandate expiry.
        // This returns evidence only; it cannot authorize another outbound call.
        if (prior.financialStartedAt || !["intended", "approved"].includes(prior.status))
          return prior;
        if (prior.runId !== execution.runId)
          throw new Error("Unstarted financial effect belongs to another Run");
      }
      const preview = await tx.tradePreview.findFirst({ where: { id: previewId, proposalId } });
      if (
        !preview ||
        preview.expiresAt <= this.now() ||
        FinancialRiskAssessmentSchema.parse(preview.risk).decision !== "ALLOW" ||
        preview.actionFingerprint !== proposal.actionFingerprint ||
        financialActionFingerprint(preview.action) !== proposal.actionFingerprint
      )
        throw new Error("Fresh allowed exact preview required");
      const { mandate, authority } = await this.authority(
        tx,
        context,
        canonicalFinancialAction(proposal.action),
      );
      if (prior) {
        if (prior.financialRunFence > execution.generation)
          throw new Error("Stale financial claim");
        return tx.externalEffect.update({
          where: { id: prior.id },
          data: {
            financialGeneration:
              prior.financialRunFence === execution.generation &&
              prior.financialHolder === execution.holder
                ? prior.financialGeneration
                : prior.financialGeneration + 1,
            financialRunFence: execution.generation,
            financialHolder: execution.holder,
          },
        });
      }
      const run = await tx.run.findUniqueOrThrow({ where: { id: execution.runId } });
      const effect = await tx.externalEffect.create({
        data: {
          spaceId: run.spaceId,
          runId: run.id,
          kind: "trade_execute",
          idempotencyKey: key,
          status: "intended",
          request: canonicalFinancialAction(proposal.action),
          financialContext: context,
          financialGeneration: 1,
          financialRunFence: execution.generation,
          financialHolder: execution.holder,
          financialExpiresAt: new Date(
            Math.min(
              authority === "FINISHING" ? Infinity : mandate.expiresAt.getTime(),
              this.now().getTime() + 600000,
            ),
          ),
        },
      });
      await this.journal(tx, effect, context, "PROPOSED", {
        previewId,
        authorityPhase: authority,
        mandateStatus: mandate.status,
        clientId: context.clientId,
      });
      return effect;
    });
  }
  async review(
    actor: ChartActor,
    id: string,
    provider: AutoReviewProvider | undefined,
    adapterContext: AdapterContext,
    knownSecrets: string[] = [],
  ) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const initial = await this.prisma.externalEffect.findUniqueOrThrow({ where: { id } });
    const initialContext = contextOf(initial);
    const financial = await this.prisma.$transaction(async (tx) => {
      const { effect, context } = await this.owned(tx, actor, id, initialContext.accountId);
      if (
        effect.status !== "intended" ||
        effect.financialStartedAt ||
        !effect.financialExpiresAt ||
        effect.financialExpiresAt <= this.now()
      )
        throw new Error("Effect is not awaiting financial review");
      if (effect.reviewDecision === "ask" || effect.reviewDecision === "error")
        throw new Error("Owner review required for prior escalation");
      if (effect.reviewDecision !== null) throw new Error("Financial review already recorded");
      const { mandate, envelope, goal } = await this.authority(
        tx,
        context,
        canonicalFinancialAction(effect.request),
      );
      const proposal = await tx.tradeProposal.findUniqueOrThrow({
        where: { id: context.proposalId },
      });
      const preview = await tx.tradePreview.findFirst({
        where: { proposalId: proposal.id },
        orderBy: { version: "desc" },
      });
      if (!preview || preview.expiresAt <= this.now()) throw new Error("Fresh preview required");
      return {
        version: 1 as const,
        policyVersion: "financial-v1" as const,
        action: canonicalFinancialAction(effect.request),
        actionFingerprint: context.actionFingerprint,
        mandateId: mandate.id,
        mandateFingerprint: mandate.fingerprint,
        mandateState: { status: mandate.status, startsAt: goal.startsAt, endsAt: goal.endsAt },
        envelope,
        planVersion: context.planVersion,
        risk: FinancialRiskAssessmentSchema.parse(preview.risk),
        observedAt: preview.observedAt.toISOString(),
        rationaleSummary: proposal.rationaleSummary,
        evidenceRefs: proposal.evidenceRefs,
        chartRefs: proposal.chartRefs,
      };
    });
    const request = FinancialReviewContextSchema.parse(financial);
    const decision = await reviewFinancialAction({
      financial: request,
      provider,
      context: adapterContext,
      knownSecrets,
      now: this.now(),
    });
    return this.prisma.$transaction(async (tx) => {
      const { effect, context } = await this.owned(tx, actor, id, initialContext.accountId);
      await this.authority(tx, context, canonicalFinancialAction(effect.request));
      if (
        effect.status !== "intended" ||
        effect.reviewDecision !== null ||
        !effect.financialExpiresAt ||
        effect.financialExpiresAt <= this.now()
      )
        throw new Error("Financial review ownership changed");
      const updated = await tx.externalEffect.update({
        where: { id },
        data: {
          reviewDecision: decision.decision,
          reviewReason: decision.reason ?? null,
          reviewModel: decision.model,
          status:
            decision.decision === "pass"
              ? "approved"
              : decision.decision === "deny"
                ? "denied"
                : "intended",
        },
      });
      await this.journal(tx, updated, context, "REVIEWED", {
        decision: decision.decision,
        reviewedAt: this.now().toISOString(),
        model: decision.model,
        reason: decision.reason ?? null,
      });
      return updated;
    });
  }
  /** Reservation and STARTED commit together; the account lock orders admission against freeze. */
  async begin(actor: ChartActor, id: string, facts: Parameters<AccountRiskLedger["reserve"]>[3]) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const initial = await this.prisma.externalEffect.findUniqueOrThrow({ where: { id } });
    const initialContext = contextOf(initial);
    return this.prisma.$transaction(async (tx) => {
      const { effect, context } = await this.owned(tx, actor, id, initialContext.accountId);
      await this.authority(tx, context, canonicalFinancialAction(effect.request));
      const humanApproved =
        effect.financialApprovedByUserId === actor.ownerUserId && !!effect.financialApprovedAt;
      if (
        effect.status !== "approved" ||
        effect.financialStartedAt ||
        !effect.financialExpiresAt ||
        effect.financialExpiresAt <= this.now() ||
        (effect.reviewDecision !== "pass" && !humanApproved)
      )
        throw new Error("Exact authorized unstarted effect required");
      if (!humanApproved) {
        const receipt = await tx.financialJournal.findFirst({
          where: { effectId: id, event: "REVIEWED" },
          orderBy: { createdAt: "desc" },
        });
        const entry = receipt?.entry;
        const reviewedAt =
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.reviewedAt === "string"
            ? Date.parse(entry.reviewedAt)
            : Number.NaN;
        const age = this.now().getTime() - reviewedAt;
        if (!Number.isFinite(age) || age < -2000 || age > 15000)
          throw new Error("Fresh independent review required; create a new proposal");
      }
      const reservation = await new AccountRiskLedger(this.prisma, this.now).reserveInTransaction(
        tx,
        actor,
        id,
        context.authorizationId,
        facts,
      );
      if (
        reservation.status !== "RESERVED" ||
        reservation.accountId !== context.accountId ||
        reservation.mode !== context.mode ||
        reservation.mandateId !== context.authorizationId ||
        reservation.actionFingerprint !== context.actionFingerprint ||
        reservation.executionGeneration !== effect.financialGeneration
      )
        throw new Error("Current risk reservation required");
      const conflicting = await tx.externalEffect.count({
        where: {
          id: { not: id },
          status: { in: ["executing", "uncertain", "reconciling"] },
          AND: [
            { financialContext: { path: ["accountId"], equals: context.accountId } },
            { financialContext: { path: ["mode"], equals: context.mode } },
          ],
        },
      });
      if (conflicting) throw new Error("Unresolved account effect blocks execution");
      const updated = await tx.externalEffect.update({
        where: { id },
        data: { status: "executing", financialStartedAt: this.now() },
      });
      await this.journal(tx, updated, context, "STARTED", {});
      if (context.mode === "LIVE") {
        if (context.version !== 2) throw new Error("Stable provider identity required");
        await tx.tradingProviderExecution.create({
          data: {
            effectId: id,
            ownerUserId: context.ownerUserId,
            accountId: context.accountId,
            clientId: context.clientId,
            actionFingerprint: context.actionFingerprint,
          },
        });
      }
      return updated;
    });
  }
  /** Trusted normalized outcome only; caller performs provider translation without raw diagnostics. */
  async settle(actor: ChartActor, id: string, raw: FinancialEffectOutcome) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const outcome = FinancialEffectOutcomeSchema.parse(raw);
    const initial = await this.prisma.externalEffect.findUniqueOrThrow({ where: { id } });
    const initialContext = contextOf(initial);
    return this.prisma.$transaction(async (tx) => {
      const { effect, context } = await this.owned(tx, actor, id, initialContext.accountId);
      if (effect.status !== "executing" || !effect.financialStartedAt)
        throw new Error("Started effect ownership required");
      const updated = await tx.externalEffect.update({
        where: { id },
        data: {
          status:
            outcome.status === "SUCCEEDED"
              ? "completed"
              : outcome.status === "FAILED"
                ? "failed"
                : "uncertain",
          result: outcome,
          financialProviderReference: outcome.providerReference,
          financialFailureCode: outcome.code,
        },
      });
      await tx.tradingRiskReservation.updateMany({
        where: { effectId: id, status: "RESERVED" },
        data: {
          status:
            outcome.status === "SUCCEEDED"
              ? "COMMITTED"
              : outcome.status === "FAILED"
                ? "RELEASED"
                : "UNCERTAIN",
          providerReference: outcome.providerReference,
        },
      });
      if (outcome.status === "UNCERTAIN")
        await tx.tradingMandate.updateMany({
          where: { id: context.authorizationId, status: { in: ["ACTIVE", "PAUSED"] } },
          data: { status: "NEEDS_RECONCILIATION", revision: { increment: 1 } },
        });
      await this.journal(tx, updated, context, outcome.status, {
        providerReference: outcome.providerReference,
        code: outcome.code,
      });
      return updated;
    });
  }
  /** Simulation acceptance is atomic with its immutable local receipt. No outbound retry. */
  async reconcileSimulation(actor: ChartActor, id: string) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const initial = await this.prisma.externalEffect.findUniqueOrThrow({ where: { id } });
    const initialContext = contextOf(initial);
    if (initialContext.mode !== "SIMULATION") throw new Error("Simulation reconciliation only");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${initialContext.accountId} FOR UPDATE`;
      const execution = await this.actor(tx, actor);
      await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${id} FOR UPDATE`;
      const effect = await tx.externalEffect.findUniqueOrThrow({ where: { id } });
      const context = contextOf(effect);
      if (context.ownerUserId !== actor.ownerUserId || context.botId !== actor.botId)
        throw new Error("Current reconciliation principal required");
      if (["completed", "failed"].includes(effect.status)) return effect;
      if (effect.status !== "uncertain" || !effect.financialStartedAt)
        throw new Error("Uncertain STARTED effect required");
      if (effect.runId && effect.runId !== execution.runId) {
        await tx.$queryRaw`SELECT id FROM runs WHERE id = ${effect.runId} FOR UPDATE`;
        const oldRun = await tx.run.findUnique({ where: { id: effect.runId } });
        if (
          oldRun?.status === "running" &&
          oldRun.leaseExpiresAt &&
          oldRun.leaseExpiresAt > this.now()
        )
          throw new Error("Previous financial Run still owns a valid lease");
      }
      const generation = effect.financialGeneration + 1;
      const receipt = await tx.simulationExecution.findUnique({ where: { effectId: id } });
      if (
        receipt &&
        (receipt.ownerUserId !== context.ownerUserId ||
          receipt.accountId !== context.accountId ||
          receipt.mandateId !== context.authorizationId ||
          receipt.actionFingerprint !== context.actionFingerprint)
      )
        throw new Error("Simulation reconciliation binding mismatch");
      // An absent receipt is proof of no local mutation only after fencing out the old Run.
      // This rule MUST NOT be used for remote broker requests.
      const outcome = receipt
        ? FinancialEffectOutcomeSchema.parse(receipt.outcome)
        : FinancialEffectOutcomeSchema.parse({
            version: 1,
            status: "FAILED",
            providerReference: null,
            code: "SIMULATION_NOT_ACCEPTED",
          });
      if (outcome.status === "UNCERTAIN") throw new Error("Ambiguous simulation receipt");
      const updated = await tx.externalEffect.update({
        where: { id },
        data: {
          status: outcome.status === "SUCCEEDED" ? "completed" : "failed",
          runId: execution.runId,
          financialGeneration: generation,
          financialRunFence: execution.generation,
          financialHolder: execution.holder,
          result: outcome,
          financialProviderReference: outcome.providerReference,
          financialFailureCode: outcome.code,
        },
      });
      await tx.tradingRiskReservation.updateMany({
        where: { effectId: id, status: "UNCERTAIN" },
        data: {
          status: outcome.status === "SUCCEEDED" ? "COMMITTED" : "RELEASED",
          providerReference: outcome.providerReference,
          executionGeneration: generation,
        },
      });
      if (
        !(await tx.externalEffect.count({
          where: {
            status: { in: ["executing", "uncertain", "reconciling"] },
            AND: [
              { financialContext: { path: ["accountId"], equals: context.accountId } },
              { financialContext: { path: ["mode"], equals: "SIMULATION" } },
            ],
          },
        }))
      )
        await tx.tradingMandate.updateMany({
          where: { id: context.authorizationId, status: "NEEDS_RECONCILIATION" },
          data: { status: "PAUSED", revision: { increment: 1 } },
        });
      await this.journal(tx, updated, context, "RECONCILED", {
        status: outcome.status,
        providerReference: outcome.providerReference,
        code: outcome.code,
        proof: receipt ? "SIMULATION_ACCEPTANCE_RECEIPT" : "FENCED_LOCAL_RECEIPT_ABSENCE",
        previousRunId: effect.runId,
        recoveryRunId: execution.runId,
        financialGeneration: generation,
      });
      return updated;
    });
  }
  /** Existing reconciler repairs process-death uncertainty; this never resends a mutation. */
  async recoverInterrupted() {
    const rows = await this.prisma.externalEffect.findMany({
      where: { financialContext: { path: ["version"], equals: 2 }, status: "executing" },
      take: 100,
      orderBy: { updatedAt: "asc" },
    });
    for (const row of rows) {
      const context = contextOf(row);
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${context.accountId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${row.id} FOR UPDATE`;
        const current = await tx.externalEffect.findUniqueOrThrow({ where: { id: row.id } });
        if (current.status !== "executing") return;
        const run = current.runId
          ? await tx.run.findUnique({ where: { id: current.runId } })
          : null;
        if (
          run?.status === "running" &&
          run.leaseExpiresAt &&
          run.leaseExpiresAt > this.now() &&
          run.leaseFence === current.financialRunFence &&
          run.leaseOwner === current.financialHolder
        )
          return;
        await tx.externalEffect.update({
          where: { id: row.id },
          data: { status: "uncertain", financialHolder: null, financialFailureCode: "INTERRUPTED" },
        });
        await tx.tradingRiskReservation.updateMany({
          where: { effectId: row.id, status: "RESERVED" },
          data: { status: "UNCERTAIN" },
        });
        await tx.tradingMandate.updateMany({
          where: { id: context.authorizationId, status: { in: ["ACTIVE", "PAUSED"] } },
          data: { status: "NEEDS_RECONCILIATION", revision: { increment: 1 } },
        });
        await this.journal(tx, current, context, "UNCERTAIN", { code: "INTERRUPTED" });
      });
    }
  }
}
