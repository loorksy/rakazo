import type { FinancialRiskFacts } from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  FinancialEffectContextSchema,
  FinancialRiskFactsSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import {
  accountRiskCapacity,
  assessFinancialAction,
  financialDecimal,
  financialUnits,
  MAIN_TRADING_AGENT_SPAWN_KEY,
} from "@rakazo/core";
import {
  canonicalFinancialAction,
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import type { ChartActor } from "./cloud-charts.js";
import { fenceChartExecution } from "./cloud-charts.js";

const consuming = ["RESERVED", "COMMITTED", "UNCERTAIN"];
/** Protected accounting only. This class exposes no broker mutation or model-facing risk input. */
export class AccountRiskLedger {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
    private readonly operatorLiveEnabled = false,
  ) {}

  /** Caller obtains facts through trusted provider preflight, never through tool/model arguments. */
  async reserve(
    actor: ChartActor,
    effectId: string,
    mandateId: string,
    rawFacts: FinancialRiskFacts,
  ) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    if (!actor.botId || !actor.execution) throw new Error("Claimed agent execution required");
    const facts = FinancialRiskFactsSchema.parse(rawFacts);
    return this.prisma.$transaction((tx) =>
      this.reserveInTransaction(tx, actor, effectId, mandateId, facts),
    );
  }
  /** Shared with STARTED admission so reservation and effect claim commit atomically. */
  async reserveInTransaction(
    tx: Prisma.TransactionClient,
    actor: ChartActor,
    effectId: string,
    mandateId: string,
    rawFacts: FinancialRiskFacts,
  ) {
    if (!actor.botId || !actor.execution) throw new Error("Claimed agent execution required");
    const facts = FinancialRiskFactsSchema.parse(rawFacts);
    // Fixed financial lock order: account -> Run -> guardrail -> mandate -> effect/reservation.
    // READ COMMITTED plus this row lock serializes all capacity reads/writes for one account.
    await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${facts.accountId} FOR UPDATE`;
    await fenceChartExecution(tx, actor);
    const account = await tx.tradingConnection.findFirst({
      where: { id: facts.accountId, ownerUserId: actor.ownerUserId, revokedAt: null },
    });
    if (!account) throw new Error("Account authority unavailable");
    const deployment = await tx.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    const main = await tx.bot.findFirst({
      where: {
        id: actor.botId,
        userId: actor.ownerUserId,
        spaceId: deployment.ownerSpaceId ?? "",
        spawnKey: MAIN_TRADING_AGENT_SPAWN_KEY,
      },
    });
    if (!main) throw new Error("Only the Main Trading Agent may reserve execution risk");
    const mandate = await tx.tradingMandate.findUnique({ where: { id: mandateId } });
    if (
      !mandate ||
      mandate.ownerUserId !== actor.ownerUserId ||
      mandate.botId !== actor.botId ||
      mandate.accountId !== facts.accountId
    )
      throw new Error("Mandate authority mismatch");
    const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
    const fingerprint = tradingMandateFingerprint(envelope);
    if (
      mandate.fingerprint !== fingerprint ||
      mandate.approvedFingerprint !== fingerprint ||
      mandate.approvedByUserId !== actor.ownerUserId ||
      mandate.status !== "ACTIVE" ||
      !mandate.approvedAt ||
      envelope.ownerId !== actor.ownerUserId ||
      envelope.botId !== actor.botId ||
      envelope.accountId !== account.id ||
      envelope.mode !== mandate.mode ||
      mandate.expiresAt.getTime() !== Date.parse(envelope.expiresAt)
    )
      throw new Error("Exact user-approved active mandate required");
    const goal = await tx.tradingGoal.findUnique({ where: { id: mandate.goalId } });
    if (
      !goal ||
      goal.ownerUserId !== actor.ownerUserId ||
      goal.botId !== actor.botId ||
      goal.accountId !== account.id ||
      goal.mode !== mandate.mode
    )
      throw new Error("Verified goal ownership required");
    const goalDefinition = TradingGoalInputSchema.parse(goal.definition);
    if (
      Date.parse(goalDefinition.startsAt) > this.now().getTime() ||
      Date.parse(goalDefinition.endsAt) <= this.now().getTime()
    )
      throw new Error("Goal time window is not active");
    if (
      await tx.tradingMissionWake.count({
        where: { mandateId: mandate.id, status: "NEEDS_ATTENTION" },
      })
    )
      throw new Error("Mission wake needs attention before new risk");
    const effect = await tx.externalEffect.findUnique({ where: { id: effectId } });
    if (!effect) throw new Error("Financial effect missing");
    const context = FinancialEffectContextSchema.parse(effect.financialContext);
    const action = canonicalFinancialAction(effect.request);
    const actionFingerprint = financialActionFingerprint(action);
    const instrument = await tx.brokerInstrument.findFirst({
      where: {
        id: action.instrumentId,
        accountId: account.id,
        brokerSymbol: action.brokerSymbol,
        active: true,
      },
    });
    if (
      action.provider !== account.provider ||
      !instrument?.verifiedAt ||
      this.now().getTime() - instrument.verifiedAt.getTime() > 300000 ||
      instrument.verifiedAt.getTime() > this.now().getTime() + 2000
    )
      throw new Error("Verified exact broker symbol required");

    if (
      context.ownerUserId !== actor.ownerUserId ||
      context.botId !== actor.botId ||
      context.accountId !== account.id ||
      context.mode !== mandate.mode ||
      context.authorizationId !== mandate.id ||
      context.actionFingerprint !== actionFingerprint ||
      action.mode !== envelope.mode ||
      effect.runId !== actor.execution?.runId
    )
      throw new Error("Financial action binding mismatch");
    if (effect.financialGeneration !== actor.execution?.generation)
      throw new Error("Stale financial execution");
    const prior = await tx.tradingRiskReservation.findUnique({ where: { effectId } });
    if (prior) {
      if (
        prior.actionFingerprint !== actionFingerprint ||
        prior.mandateId !== mandate.id ||
        prior.executionGeneration > actor.execution.generation ||
        prior.status !== "RESERVED" ||
        effect.financialStartedAt !== null
      )
        throw new Error("Reservation identity mismatch");
    }
    if (effect.status !== "approved") throw new Error("Financial action is not authorized");
    const guardrail = await tx.accountRiskGuardrail.findUnique({
      where: { accountId_mode: { accountId: account.id, mode: mandate.mode } },
    });
    if (!guardrail || guardrail.ownerUserId !== actor.ownerUserId)
      throw new Error("Account guardrails required");
    await tx.$queryRaw`SELECT id FROM account_risk_guardrails WHERE id = ${guardrail.id} FOR UPDATE`;
    const limits = AccountRiskGuardrailsSchema.parse(guardrail.limits);
    if (
      limits.accountId !== account.id ||
      limits.mode !== mandate.mode ||
      limits.revision !== guardrail.revision ||
      guardrail.frozen ||
      limits.frozen ||
      !limits.autonomousEnabled
    )
      throw new Error("Account authority is frozen or disabled");
    if (mandate.mode === "LIVE") {
      if (!this.operatorLiveEnabled || !account.verifiedAt)
        throw new Error("LIVE trading disabled");
      const lease = await tx.brokerSessionLease.findUnique({ where: { accountId: account.id } });
      if (
        lease?.state !== "CONNECTED" ||
        !lease.expiresAt ||
        lease.expiresAt <= this.now() ||
        lease.credentialVersion !== account.credentialVersion
      )
        throw new Error("Verified broker session required");
      // Readiness is intentionally not implied by a valid socket; no live executor exists yet.
      throw new Error("LIVE readiness has not been established");
    }
    if (limits.maxDrawdown !== null) throw new Error("Verified account drawdown baseline required");
    if (
      !mandate.observedAt ||
      this.now().getTime() - mandate.observedAt.getTime() > 15000 ||
      mandate.observedAt.getTime() > this.now().getTime() + 2000
    )
      throw new Error("Fresh mission accounting required");
    const active = await tx.tradingMandate.count({
      where: { accountId: account.id, mode: mandate.mode, status: "ACTIVE" },
    });
    if (active > limits.maxActiveMandates) throw new Error("Active mandate account limit reached");
    const allReservations = await tx.tradingRiskReservation.findMany({
      where: { accountId: account.id, mode: mandate.mode, status: { in: consuming } },
      take: 10001,
    });
    if (allReservations.length > 10000) throw new Error("Risk ledger capacity exceeded");
    const reservations = allReservations.filter((row) => row.effectId !== effectId);
    const own = reservations.filter((row) => row.mandateId === mandate.id);
    const sum = (rows: typeof reservations, field: "risk" | "exposure") =>
      rows.reduce((total, row) => total + financialUnits(row[field].toFixed()), 0n);
    const unresolved = await tx.externalEffect.count({
      where: {
        status: { in: ["executing", "uncertain", "reconciling"] },
        AND: [
          { financialContext: { path: ["accountId"], equals: account.id } },
          { financialContext: { path: ["mode"], equals: mandate.mode } },
        ],
      },
    });
    // Management reservations require provider-owned target attribution; this first ledger path
    // accepts new exposure only and cannot accidentally reinterpret a modification as an open.
    if (action.operation !== "OPEN") throw new Error("Verified management attribution required");
    const assessment = assessFinancialAction({
      action,
      envelope,
      facts,
      now: this.now(),
      state: {
        version: 1,
        missionPnl: mandate.missionPnl.toFixed(),
        dailyPnl: mandate.dailyPnl.toFixed(),
        openRisk: financialDecimal(sum(own, "risk")),
        openNotional: financialDecimal(sum(own, "exposure")),
        positions: own.filter((row) => row.kind === "POSITION").length,
        pendingOrders: own.filter((row) => row.kind === "PENDING").length,
        unresolvedEffects: unresolved > 0,
        missionActive: true,
        accountFrozen: false,
      },
    });
    if (assessment.decision !== "ALLOW") throw new Error(`Risk denied: ${assessment.code}`);
    const capacity = accountRiskCapacity({
      action,
      mandateId: mandate.id,
      envelope,
      limits,
      facts,
      assessment,
      reservations: reservations.map((row) => ({
        ...row,
        risk: row.risk.toFixed(),
        exposure: row.exposure.toFixed(),
        margin: row.margin.toFixed(),
      })),
    });
    if (capacity) throw new Error(`Account capacity denied: ${capacity}`);
    const pending = action.orderType !== "MARKET";
    const reservationData = {
      ownerUserId: actor.ownerUserId,
      accountId: account.id,
      mode: mandate.mode,
      mandateId,
      effectId,
      actionFingerprint,
      kind: pending ? "PENDING" : "POSITION",
      risk: assessment.incrementalRisk,
      exposure: assessment.notional,
      margin: assessment.margin,
      executionGeneration: actor.execution?.generation ?? 0,
    };
    const reservation = prior
      ? await tx.tradingRiskReservation.update({ where: { id: prior.id }, data: reservationData })
      : await tx.tradingRiskReservation.create({ data: reservationData });
    await tx.financialJournal.create({
      data: {
        ownerUserId: actor.ownerUserId,
        accountId: account.id,
        mode: mandate.mode,
        effectId,
        event: prior ? "RISK_REVALIDATED" : "RISK_RESERVED",
        entry: {
          version: 1,
          mandateId,
          actionFingerprint,
          assessment,
          accountRiskBefore: financialDecimal(sum(reservations, "risk")),
          accountRiskAfter: financialDecimal(
            sum(reservations, "risk") + financialUnits(assessment.incrementalRisk),
          ),
        },
      },
    });
    return reservation;
  }
}
