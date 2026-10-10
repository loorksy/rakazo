import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob, tradingMissionWakeJob } from "@rakazo/adapter-kit";
import {
  AccountRiskGuardrailsSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
  TradingPlanInputSchema,
} from "@rakazo/contracts";
import { tradingMandateFingerprint } from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDurableBotWake } from "./durable-bot-wake.js";

type Mandate = Prisma.TradingMandateGetPayload<Record<never, never>>;
export async function saveMissionWakes(tx: Prisma.TransactionClient, mandate: Mandate) {
  const goal = TradingGoalInputSchema.parse(
    (await tx.tradingGoal.findUniqueOrThrow({ where: { id: mandate.goalId } })).definition,
  );
  const start = new Date(goal.startsAt);
  for (const [kind, dueAt] of [
    ["START", start],
    ["EXPIRE", mandate.expiresAt],
  ] as const)
    await tx.tradingMissionWake.upsert({
      where: { wakeKey: `mandate:${mandate.id}:${kind}` },
      create: { mandateId: mandate.id, wakeKey: `mandate:${mandate.id}:${kind}`, kind, dueAt },
      update: {},
    });
  await savePlanWakes(tx, mandate, mandate.planId);
}
export async function savePlanWakes(
  tx: Prisma.TransactionClient,
  mandate: Mandate,
  planId: string,
) {
  const row = await tx.tradingPlan.findUniqueOrThrow({ where: { id: planId } });
  if (row.goalId !== mandate.goalId) throw new Error("Plan wake scope mismatch");
  const plan = TradingPlanInputSchema.parse(row.definition);
  await tx.tradingMissionWake.updateMany({
    where: {
      mandateId: mandate.id,
      kind: "REEVALUATE",
      status: { in: ["WAITING", "DELIVERY_NEEDED"] },
    },
    data: { status: "CANCELLED" },
  });
  for (const time of [...new Set(plan.monitoring.reevaluationAt)].sort()) {
    const dueAt = new Date(time);
    if (dueAt > mandate.expiresAt) throw new Error("Plan wake exceeds mandate expiry");
    const key = `mandate:${mandate.id}:plan:${row.version}:${dueAt.toISOString()}`;
    await tx.tradingMissionWake.upsert({
      where: { wakeKey: key },
      create: { mandateId: mandate.id, wakeKey: key, kind: "REEVALUATE", dueAt },
      update: {},
    });
  }
}

/** The existing job host owns timers; a periodic reconciler only repairs enqueue/delivery gaps. */
export async function enqueueMissionWakes(
  prisma: PrismaClient,
  jobs: JobPublisher,
  mandateId?: string,
  now = new Date(),
) {
  const rows = await prisma.tradingMissionWake.findMany({
    where: {
      ...(mandateId ? { mandateId } : {}),
      status: { in: ["WAITING", "DELIVERY_NEEDED"] },
      ...(!mandateId ? { dueAt: { lte: new Date(now.getTime() + 60000) } } : {}),
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  await Promise.all(rows.map((row) => jobs.enqueue(tradingMissionWakeJob(row.id, row.dueAt))));
}
export async function wakeTradingMission(
  prisma: PrismaClient,
  jobs: JobPublisher,
  id: string,
  scheduledFor: string,
  now = new Date(),
) {
  const initial = await prisma.tradingMissionWake.findUnique({ where: { id } });
  if (!initial || initial.dueAt.getTime() !== Date.parse(scheduledFor) || initial.dueAt > now)
    return;
  const initialMandate = await prisma.tradingMandate.findUnique({
    where: { id: initial.mandateId },
  });
  if (!initialMandate) return;
  const runId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${initialMandate.accountId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM trading_mandates WHERE id = ${initial.mandateId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM trading_mission_wakes WHERE id = ${id} FOR UPDATE`;
    const wake = await tx.tradingMissionWake.findUniqueOrThrow({ where: { id } });
    if (!["WAITING", "DELIVERY_NEEDED"].includes(wake.status) || wake.completedAt) return null;
    const mandate = await tx.tradingMandate.findUniqueOrThrow({ where: { id: wake.mandateId } });
    const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
    if (
      mandate.approvedFingerprint !== tradingMandateFingerprint(envelope) ||
      mandate.approvedByUserId !== mandate.ownerUserId ||
      !mandate.approvedAt
    )
      throw new Error("Approved mandate required for wake");
    const allowed =
      wake.kind === "ACCOUNT_EVENT"
        ? [
            "ACTIVE",
            "APPROVED_WAITING",
            "PAUSED",
            "RISK_STOPPED",
            "TARGET_REACHED",
            "EXPIRED",
            "CANCELLED",
            "NEEDS_ATTENTION",
            "NEEDS_RECONCILIATION",
            "COMPLETED",
            "EMERGENCY_STOPPED",
          ]
        : wake.kind === "EXPIRE"
          ? ["ACTIVE", "APPROVED_WAITING", "PAUSED", "NEEDS_ATTENTION", "EXPIRED"]
          : [
              "ACTIVE",
              "APPROVED_WAITING",
              ...(wake.status === "DELIVERY_NEEDED" ? ["NEEDS_ATTENTION"] : []),
            ];
    if (!allowed.includes(mandate.status)) {
      await tx.tradingMissionWake.update({ where: { id }, data: { status: "CANCELLED" } });
      return null;
    }
    if (wake.kind !== "EXPIRE" && wake.kind !== "ACCOUNT_EVENT" && mandate.expiresAt <= now) {
      await tx.tradingMissionWake.update({ where: { id }, data: { status: "CANCELLED" } });
      return null;
    }
    // Missed analysis deadlines are semantic reevaluations, not independent user reports.
    // A current analysis covers older deadlines; account/effect events are never discarded here.
    if (wake.kind === "REEVALUATE") {
      const later = await tx.tradingMissionWake.findFirst({
        where: {
          mandateId: mandate.id,
          kind: "REEVALUATE",
          dueAt: { gt: wake.dueAt, lte: now },
          status: { in: ["WAITING", "DELIVERY_NEEDED", "QUEUED", "COMPLETED"] },
        },
      });
      if (later) {
        await tx.tradingMissionWake.update({
          where: { id },
          data: { status: "COALESCED", completedAt: now },
        });
        return null;
      }
    }
    if (wake.kind === "START" || wake.kind === "REEVALUATE")
      await tx.tradingMissionWake.updateMany({
        where: {
          mandateId: mandate.id,
          id: { not: id },
          kind: "REEVALUATE",
          dueAt: { lte: now },
          status: { in: ["WAITING", "DELIVERY_NEEDED"] },
        },
        data: { status: "COALESCED", completedAt: now },
      });
    if (wake.kind === "START" && mandate.status === "APPROVED_WAITING") {
      const guard = await tx.accountRiskGuardrail.findUnique({
        where: { accountId_mode: { accountId: mandate.accountId, mode: mandate.mode } },
      });
      const limits = guard ? AccountRiskGuardrailsSchema.parse(guard.limits) : null;
      const active = await tx.tradingMandate.count({
        where: { accountId: mandate.accountId, mode: mandate.mode, status: "ACTIVE" },
      });
      const account = await tx.tradingConnection.findFirst({
        where: { id: mandate.accountId, ownerUserId: mandate.ownerUserId, revokedAt: null },
      });
      const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
      const bot = await tx.bot.findFirst({
        where: {
          id: mandate.botId,
          userId: mandate.ownerUserId,
          spaceId: settings?.ownerSpaceId ?? "",
        },
      });
      const canStart =
        account &&
        bot &&
        settings?.ownerUserId === mandate.ownerUserId &&
        guard?.ownerUserId === mandate.ownerUserId &&
        limits?.accountId === mandate.accountId &&
        limits?.mode === mandate.mode &&
        limits?.revision === guard?.revision &&
        limits?.autonomousEnabled &&
        !limits.frozen &&
        !guard?.frozen &&
        active < limits.maxActiveMandates;
      await tx.tradingMandate.update({
        where: { id: mandate.id },
        data: { status: canStart ? "ACTIVE" : "NEEDS_ATTENTION", revision: { increment: 1 } },
      });
    }
    if (wake.kind === "EXPIRE" && mandate.status !== "EXPIRED") {
      await tx.tradingMandate.update({
        where: { id: mandate.id },
        data: { status: "EXPIRED", revision: { increment: 1 } },
      });
      await tx.tradingMissionWake.updateMany({
        where: {
          mandateId: mandate.id,
          id: { not: id },
          status: { in: ["WAITING", "DELIVERY_NEEDED"] },
        },
        data: { status: "CANCELLED" },
      });
    }
    const delivered = await createDurableBotWake(tx, {
      ownerUserId: mandate.ownerUserId,
      botId: mandate.botId,
      key: wake.wakeKey,
      prompt: `Trading mission ${wake.kind.toLowerCase()}. Mandate ${mandate.id}; goal ${mandate.goalId}. Read current goal, plan and backend authorization before analysis. Profit is aspirational; choose no trade when appropriate. Do not bypass deterministic risk, review or effect reconciliation. Expiry stops new risk. Approved finishing behaviors: expiry ${envelope.expiryBehavior}, target ${envelope.targetBehavior}, breach ${envelope.breachBehavior}, emergency ${envelope.emergencyBehavior ?? "FREEZE"}. Read current backend state and carry out only its exact pre-authorized cancellations or full attributed closes through structured proposal, risk, review and effect tools when permitted. FREEZE requires no new mutation. A finishing action never reactivates authority. This wake is not financial authorization.`,
    });
    await tx.tradingMissionWake.update({
      where: { id },
      data: { status: delivered ? "QUEUED" : "DELIVERY_NEEDED", runId: delivered },
    });
    if (wake.status === "WAITING")
      await tx.financialJournal.create({
        data: {
          ownerUserId: mandate.ownerUserId,
          accountId: mandate.accountId,
          mode: mandate.mode,
          goalId: mandate.goalId,
          mandateId: mandate.id,
          event: `MISSION_${wake.kind}`,
          entry: {
            version: 1,
            wakeId: id,
            dueAt: wake.dueAt.toISOString(),
            deliveryNeeded: delivered === null,
          },
        },
      });
    return delivered;
  });
  if (runId) await jobs.enqueue(runContinueJob(runId));
}
