import { createHash } from "node:crypto";
import type {
  AccountRiskGuardrails,
  TradingGoalView,
  TradingMandateView,
  TradingMissionResponse,
  TradingPlanView,
} from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  MandateControlSchema,
  MandateResolutionSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
  TradingMissionCommandSchema,
  TradingPlanInputSchema,
} from "@rakazo/contracts";
import { MAIN_TRADING_AGENT_SPAWN_KEY } from "@rakazo/core";
import { tradingMandateFingerprint } from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import type { ChartActor } from "./cloud-charts.js";
import { fenceChartExecution } from "./cloud-charts.js";
import { saveMissionWakes, savePlanWakes } from "./trading-mission-wakes.js";

type Goal = Prisma.TradingGoalGetPayload<Record<never, never>>;
type Plan = Prisma.TradingPlanGetPayload<Record<never, never>>;
type Mandate = Prisma.TradingMandateGetPayload<Record<never, never>>;
function projectGoal(row: Goal): TradingGoalView {
  return {
    id: row.id,
    goal: TradingGoalInputSchema.parse(row.definition),
    status: row.status,
    targetGuaranteed: false as const,
  };
}
function projectPlan(row: Plan): TradingPlanView {
  return {
    id: row.id,
    goalId: row.goalId,
    version: row.version,
    plan: TradingPlanInputSchema.parse(row.definition),
  };
}
function projectMandate(row: Mandate): TradingMandateView {
  return {
    id: row.id,
    goalId: row.goalId,
    planId: row.planId,
    status: row.status,
    revision: row.revision,
    envelope: TradingMandateEnvelopeSchema.parse(row.envelope),
    fingerprint: row.fingerprint,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    missionPnl: row.missionPnl.toFixed(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
/** Domain state behind the existing Bot/Run runtime. These commands never execute broker mutations. */
export class TradingMissions {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async main(tx: Prisma.TransactionClient, ownerUserId: string) {
    const settings = await tx.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
    const bot = await tx.bot.findFirst({
      where: {
        userId: ownerUserId,
        spaceId: settings.ownerSpaceId ?? "",
        spawnKey: MAIN_TRADING_AGENT_SPAWN_KEY,
      },
    });
    if (!bot) throw new Error("Main Trading Agent unavailable");
    return bot;
  }
  async command(
    actor: ChartActor,
    raw: unknown,
    operationKey?: string,
  ): Promise<TradingMissionResponse> {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const command = TradingMissionCommandSchema.parse(raw);
    return this.prisma.$transaction(async (tx) => {
      await fenceChartExecution(tx, actor);
      const bot = await this.main(tx, actor.ownerUserId);
      if (actor.botId && actor.botId !== bot.id)
        throw new Error("Research peers cannot acquire mandate authority");
      const scope = { ownerUserId: actor.ownerUserId, botId: bot.id };
      if (command.operation === "list")
        return (
          await tx.tradingGoal.findMany({ where: scope, orderBy: { createdAt: "desc" }, take: 100 })
        ).map(projectGoal);
      if (command.operation === "goal_create") {
        const definition = TradingGoalInputSchema.parse(command.goal);
        const duration = Date.parse(definition.endsAt) - Date.parse(definition.startsAt);
        if (Date.parse(definition.endsAt) <= this.now().getTime() || duration > 90 * 86400000)
          throw new Error("Choose a future goal expiry within a bounded 90-day window");
        const account = await tx.tradingConnection.findFirst({
          where: { id: definition.accountId, ownerUserId: actor.ownerUserId, revokedAt: null },
        });
        if (!account)
          throw new Error(
            "Choose an owner broker connection; analysis does not grant live authority",
          );
        const normalized = {
          ...definition,
          startsAt: new Date(definition.startsAt).toISOString(),
          endsAt: new Date(definition.endsAt).toISOString(),
          allowedInstruments: [...new Set(definition.allowedInstruments)].sort(),
        };
        const requestKey = createHash("sha256")
          .update(JSON.stringify([actor.ownerUserId, bot.id, operationKey ?? normalized]))
          .digest("hex");
        await tx.$queryRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;
        const prior = await tx.tradingGoal.findUnique({ where: { requestKey } });
        if (prior) {
          if (
            JSON.stringify(TradingGoalInputSchema.parse(prior.definition)) !==
            JSON.stringify(normalized)
          )
            throw new Error("Goal request identity changed");
          return projectGoal(prior);
        }
        if ((await tx.tradingGoal.count({ where: scope })) >= 1000)
          throw new Error("Goal capacity reached");
        return projectGoal(
          await tx.tradingGoal.create({
            data: {
              ...scope,
              accountId: account.id,
              mode: definition.mode,
              definition: normalized,
              requestKey,
            },
          }),
        );
      }
      if (command.operation === "get" || command.operation === "plan_create") {
        await tx.$queryRaw`SELECT id FROM trading_goals WHERE id = ${command.goalId} FOR UPDATE`;
        const goal = await tx.tradingGoal.findFirst({ where: { id: command.goalId, ...scope } });
        if (!goal) throw new Error("Goal unavailable");
        if (command.operation === "get")
          return {
            goal: projectGoal(goal),
            plans: (
              await tx.tradingPlan.findMany({
                where: { goalId: goal.id },
                orderBy: { version: "desc" },
                take: 64,
              })
            ).map(projectPlan),
            mandates: (
              await tx.tradingMandate.findMany({
                where: { goalId: goal.id, ...scope },
                orderBy: { createdAt: "desc" },
                take: 64,
              })
            ).map(projectMandate),
          };
        const latest = await tx.tradingPlan.findFirst({
          where: { goalId: goal.id },
          orderBy: { version: "desc" },
        });
        if ((latest?.version ?? 0) !== command.expectedVersion)
          throw new Error("Plan revision conflict");
        if ((latest?.version ?? 0) >= 128) throw new Error("Plan version capacity reached");
        const definition = TradingGoalInputSchema.parse(goal.definition);
        const plan = TradingPlanInputSchema.parse(command.plan);
        const envelope = TradingMandateEnvelopeSchema.parse({
          ...plan.riskProposal,
          ownerId: actor.ownerUserId,
          botId: bot.id,
          accountId: goal.accountId,
          mode: goal.mode,
        });
        if (
          envelope.currency !== definition.currency ||
          Date.parse(envelope.expiresAt) > Date.parse(definition.endsAt) ||
          Date.parse(envelope.expiresAt) <= this.now().getTime() ||
          envelope.supervisionPositionId !== definition.positionId
        )
          throw new Error("Risk proposal must fit the selected goal, currency and duration");
        if (
          definition.allowedInstruments.length &&
          envelope.allowedInstruments.some((id) => !definition.allowedInstruments.includes(id))
        )
          throw new Error("Risk proposal exceeds requested market scope");
        if (plan.marketScope.some((id) => !envelope.allowedInstruments.includes(id)))
          throw new Error("Plan market scope exceeds proposed authority");
        for (const timestamp of plan.monitoring.reevaluationAt)
          if (
            Date.parse(timestamp) > Date.parse(envelope.expiresAt) ||
            Date.parse(timestamp) <= this.now().getTime() ||
            Date.parse(timestamp) < Date.parse(definition.startsAt)
          )
            throw new Error("Choose reevaluation times inside the proposed window");
        const instruments = await tx.brokerInstrument.count({
          where: {
            id: { in: [...new Set(envelope.allowedInstruments)] },
            accountId: goal.accountId,
            active: true,
          },
        });
        if (instruments !== new Set(envelope.allowedInstruments).size)
          throw new Error("Choose exact account-scoped broker instruments");
        const created = await tx.tradingPlan.create({
          data: { goalId: goal.id, version: command.expectedVersion + 1, definition: plan },
        });
        const active = await tx.tradingMandate.findMany({
          where: { goalId: goal.id, ...scope, status: { in: ["ACTIVE", "APPROVED_WAITING"] } },
          take: 100,
        });
        for (const mandate of active) await savePlanWakes(tx, mandate, created.id);
        return projectPlan(created);
      }
      const plan = await tx.tradingPlan.findUnique({ where: { id: command.planId } });
      if (!plan) throw new Error("Plan unavailable");
      await tx.$queryRaw`SELECT id FROM trading_goals WHERE id = ${plan.goalId} FOR UPDATE`;
      const goal = await tx.tradingGoal.findFirst({ where: { id: plan.goalId, ...scope } });
      if (!goal) throw new Error("Plan authority mismatch");
      const definition = TradingPlanInputSchema.parse(plan.definition);
      const envelope = TradingMandateEnvelopeSchema.parse({
        ...definition.riskProposal,
        ownerId: actor.ownerUserId,
        botId: bot.id,
        accountId: goal.accountId,
        mode: goal.mode,
      });
      const fingerprint = tradingMandateFingerprint(envelope);
      const prior = await tx.tradingMandate.findFirst({
        where: { goalId: goal.id, planId: plan.id, fingerprint, ...scope },
      });
      if (prior) return projectMandate(prior);
      const mandate = await tx.tradingMandate.create({
        data: {
          ...scope,
          accountId: goal.accountId,
          mode: goal.mode,
          goalId: goal.id,
          planId: plan.id,
          envelope,
          fingerprint,
          expiresAt: new Date(envelope.expiresAt),
        },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: actor.ownerUserId,
          accountId: goal.accountId,
          mode: goal.mode,
          goalId: goal.id,
          mandateId: mandate.id,
          planVersion: plan.version,
          event: "MANDATE_PROPOSED",
          entry: { version: 1, fingerprint, envelope },
        },
      });
      await tx.tradingGoal.update({
        where: { id: goal.id },
        data: { status: "AWAITING_MANDATE_APPROVAL" },
      });
      return projectMandate(mandate);
    });
  }
  /** Authenticated human endpoint only. No agent tool accepts this command or approved metadata. */
  async resolveMandate(ownerUserId: string, raw: unknown) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const command = MandateResolutionSchema.parse(raw);
    const initial = await this.prisma.tradingMandate.findFirst({
      where: { id: command.id, ownerUserId },
    });
    if (!initial) throw new Error("Mandate unavailable");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${initial.accountId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM trading_mandates WHERE id = ${command.id} FOR UPDATE`;
      const mandate = await tx.tradingMandate.findUniqueOrThrow({ where: { id: command.id } });
      const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
      const fingerprint = tradingMandateFingerprint(envelope);
      if (
        mandate.ownerUserId !== ownerUserId ||
        mandate.revision !== command.expectedRevision ||
        mandate.status !== "AWAITING_APPROVAL" ||
        fingerprint !== command.fingerprint ||
        fingerprint !== mandate.fingerprint
      )
        throw new Error("Exact current mandate approval required");
      if (!command.approve) {
        await tx.financialJournal.create({
          data: {
            ownerUserId,
            accountId: mandate.accountId,
            mode: mandate.mode,
            goalId: mandate.goalId,
            mandateId: mandate.id,
            event: "MANDATE_DENIED",
            entry: { version: 1, fingerprint },
          },
        });
        return projectMandate(
          await tx.tradingMandate.update({
            where: { id: mandate.id },
            data: { status: "CANCELLED", revision: { increment: 1 } },
          }),
        );
      }
      if (mandate.expiresAt <= this.now()) throw new Error("Mandate expired");
      const goal = await tx.tradingGoal.findUniqueOrThrow({ where: { id: mandate.goalId } });
      const objective = TradingGoalInputSchema.parse(goal.definition);
      if (mandate.mode === "LIVE")
        throw new Error("LIVE readiness incomplete; live activation is disabled");
      const bot = await this.main(tx, ownerUserId);
      if (bot.id !== mandate.botId)
        throw new Error("Authorized Bot identity changed; propose a new mandate");
      const account = await tx.tradingConnection.findFirst({
        where: { id: mandate.accountId, ownerUserId, revokedAt: null },
      });
      if (!account) throw new Error("Account unavailable");
      const guardrail = await tx.accountRiskGuardrail.findUnique({
        where: { accountId_mode: { accountId: mandate.accountId, mode: mandate.mode } },
      });
      if (!guardrail || guardrail.ownerUserId !== ownerUserId)
        throw new Error("Configure account guardrails before activation");
      const limits = AccountRiskGuardrailsSchema.parse(guardrail.limits);
      if (guardrail.frozen || limits.frozen || !limits.autonomousEnabled)
        throw new Error("Account autonomous authority is disabled or frozen");
      const count = await tx.tradingMandate.count({
        where: { accountId: account.id, mode: mandate.mode, status: "ACTIVE" },
      });
      if (count >= limits.maxActiveMandates)
        throw new Error("Account active mandate limit reached");
      const next = await tx.tradingMandate.update({
        where: { id: mandate.id },
        data: {
          status:
            Date.parse(objective.startsAt) > this.now().getTime() ? "APPROVED_WAITING" : "ACTIVE",
          approvedFingerprint: fingerprint,
          approvedByUserId: ownerUserId,
          approvedAt: this.now(),
          revision: { increment: 1 },
        },
      });
      await saveMissionWakes(tx, next);
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId: mandate.accountId,
          mode: mandate.mode,
          goalId: mandate.goalId,
          mandateId: mandate.id,
          event: "MANDATE_APPROVED",
          entry: { version: 1, fingerprint, revision: next.revision },
        },
      });
      await tx.tradingGoal.update({ where: { id: mandate.goalId }, data: { status: next.status } });
      return projectMandate(next);
    });
  }
  /** Risk capacity administration is never reachable through a Bot command. */
  async setAccountGuardrails(ownerUserId: string, raw: AccountRiskGuardrails) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const limits = AccountRiskGuardrailsSchema.parse(raw);
    if (limits.mode === "LIVE")
      throw new Error("LIVE readiness incomplete; live activation is disabled");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${limits.accountId} FOR UPDATE`;
      const account = await tx.tradingConnection.findFirst({
        where: { id: limits.accountId, ownerUserId, revokedAt: null },
      });
      if (!account) throw new Error("Account unavailable");
      const current = await tx.accountRiskGuardrail.findUnique({
        where: { accountId_mode: { accountId: account.id, mode: limits.mode } },
      });
      if (current && (current.ownerUserId !== ownerUserId || current.revision !== limits.revision))
        throw new Error("Account guardrail revision conflict");
      if (!current && limits.revision !== 1)
        throw new Error("Initial guardrail revision must be one");
      const next = { ...limits, revision: current ? current.revision + 1 : 1 };
      await tx.accountRiskGuardrail.upsert({
        where: { accountId_mode: { accountId: account.id, mode: limits.mode } },
        create: {
          ownerUserId,
          accountId: account.id,
          mode: limits.mode,
          revision: next.revision,
          limits: next,
          frozen: next.frozen,
        },
        update: { revision: next.revision, limits: next, frozen: next.frozen },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId: account.id,
          mode: next.mode,
          event: "ACCOUNT_GUARDRAILS_CHANGED",
          entry: next,
        },
      });
      return next;
    });
  }
  async accountGuardrails(
    ownerUserId: string,
    accountId: string,
    mode: AccountRiskGuardrails["mode"],
  ) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const row = await this.prisma.accountRiskGuardrail.findUnique({
      where: { accountId_mode: { accountId, mode } },
    });
    if (!row || row.ownerUserId !== ownerUserId) return null;
    return AccountRiskGuardrailsSchema.parse({
      ...AccountRiskGuardrailsSchema.parse(row.limits),
      revision: row.revision,
      frozen: row.frozen,
    });
  }
  /** Stop never silently closes a broker position. Pre-authorized finishing effects are separate. */
  async controlMandate(ownerUserId: string, raw: unknown) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const command = MandateControlSchema.parse(raw);
    const initial = await this.prisma.tradingMandate.findFirst({
      where: { id: command.id, ownerUserId },
    });
    if (!initial) throw new Error("Mandate unavailable");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${initial.accountId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM trading_mandates WHERE id = ${initial.id} FOR UPDATE`;
      const mandate = await tx.tradingMandate.findUniqueOrThrow({ where: { id: initial.id } });
      if (mandate.ownerUserId !== ownerUserId || mandate.revision !== command.expectedRevision)
        throw new Error("Mandate revision conflict");
      if (!["ACTIVE", "APPROVED_WAITING", "PAUSED", "NEEDS_ATTENTION"].includes(mandate.status))
        throw new Error("Mandate cannot change from its current state");
      if (command.action === "EMERGENCY_STOP") {
        const row = await tx.accountRiskGuardrail.findUniqueOrThrow({
          where: { accountId_mode: { accountId: mandate.accountId, mode: mandate.mode } },
        });
        const limits = AccountRiskGuardrailsSchema.parse(row.limits);
        await tx.accountRiskGuardrail.update({
          where: { id: row.id },
          data: {
            frozen: true,
            revision: { increment: 1 },
            limits: { ...limits, frozen: true, revision: row.revision + 1 },
          },
        });
      }
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId: mandate.accountId,
          mode: mandate.mode,
          goalId: mandate.goalId,
          mandateId: mandate.id,
          event: command.action,
          entry: {
            version: 1,
            fingerprint: mandate.fingerprint,
            revision: mandate.revision + 1,
            closesPositions: false,
          },
        },
      });
      return projectMandate(
        await tx.tradingMandate.update({
          where: { id: mandate.id },
          data: {
            status: command.action === "CANCEL" ? "CANCELLED" : "PAUSED",
            revision: { increment: 1 },
          },
        }),
      );
    });
  }
}
