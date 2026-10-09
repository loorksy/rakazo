import { createHash } from "node:crypto";
import type { FinancialAction, FinancialRiskFacts, TradeProposalView } from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  FinancialRiskFactsSchema,
  TradePrepareCommandSchema,
  TradePreviewViewSchema,
  TradeProposalViewSchema,
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
} from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import type { ChartActor } from "./cloud-charts.js";
import { fenceChartExecution } from "./cloud-charts.js";
import { requestBrokerRead } from "./trading-connections.js";

type Proposal = Prisma.TradeProposalGetPayload<Record<never, never>>;
type TrustedPreflight = (
  ownerUserId: string,
  action: FinancialAction,
  signal?: AbortSignal,
) => Promise<FinancialRiskFacts>;
/** Preparation only; no method grants approval or calls a broker mutation endpoint. */
export class TradeProposals {
  private readonly preflight: TrustedPreflight;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
    preflight?: TrustedPreflight,
  ) {
    this.preflight =
      preflight ??
      (async (ownerUserId, action, signal) =>
        FinancialRiskFactsSchema.parse(
          await requestBrokerRead(
            prisma,
            ownerUserId,
            {
              operation: "preflight",
              accountId: action.accountId,
              instrumentId: action.instrumentId,
              action,
            },
            signal,
          ),
        ));
  }
  private async main(tx: Prisma.TransactionClient, actor: ChartActor) {
    await fenceChartExecution(tx, actor);
    const settings = await tx.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
    const bot = await tx.bot.findFirst({
      where: {
        userId: actor.ownerUserId,
        spaceId: settings.ownerSpaceId ?? "",
        spawnKey: MAIN_TRADING_AGENT_SPAWN_KEY,
        ...(actor.botId ? { id: actor.botId } : {}),
      },
    });
    if (!bot) throw new Error("Only the Main Trading Agent may prepare financial actions");
    return bot;
  }
  private async project(tx: Prisma.TransactionClient, row: Proposal): Promise<TradeProposalView> {
    const preview = await tx.tradePreview.findFirst({
      where: { proposalId: row.id },
      orderBy: { version: "desc" },
    });
    return TradeProposalViewSchema.parse({
      id: row.id,
      goalId: row.goalId,
      mandateId: row.mandateId,
      planId: row.planId,
      planVersion: row.planVersion,
      action: row.action,
      actionFingerprint: row.actionFingerprint,
      rationaleSummary: row.rationaleSummary,
      evidenceRefs: row.evidenceRefs,
      chartRefs: row.chartRefs,
      revision: row.revision,
      status: row.status,
      preview: preview
        ? TradePreviewViewSchema.parse({
            id: preview.id,
            proposalId: row.id,
            version: preview.version,
            action: preview.action,
            actionFingerprint: preview.actionFingerprint,
            risk: preview.risk,
            observedAt: preview.observedAt.toISOString(),
            expiresAt: preview.expiresAt.toISOString(),
            authorizationGranted: false,
          })
        : null,
    });
  }
  async command(
    actor: ChartActor,
    raw: unknown,
    operationKey?: string,
    signal?: AbortSignal,
  ): Promise<TradeProposalView | TradeProposalView[]> {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const command = TradePrepareCommandSchema.parse(raw);
    // Validate current ownership before any trusted provider read; recheck the fence after IO.
    const input = await this.prisma.$transaction(async (tx) => {
      if (command.operation === "create")
        await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${command.action.accountId} FOR UPDATE`;
      const bot = await this.main(tx, actor);
      const scope = { ownerUserId: actor.ownerUserId, botId: bot.id };
      if (command.operation === "get" || command.operation === "preview") {
        const row = await tx.tradeProposal.findFirst({
          where: { id: command.proposalId, ...scope },
        });
        if (!row) throw new Error("Proposal unavailable");
        if (command.operation === "get") return { result: await this.project(tx, row) };
        if (row.revision !== command.expectedRevision)
          throw new Error("Proposal revision conflict");
        return { row };
      }
      const mandate = await tx.tradingMandate.findFirst({
        where: { id: command.mandateId, ...scope },
      });
      if (!mandate) throw new Error("Mandate unavailable");
      if (command.operation === "list")
        return {
          result: await Promise.all(
            (
              await tx.tradeProposal.findMany({
                where: { ...scope, mandateId: mandate.id },
                orderBy: { createdAt: "desc" },
                take: 100,
              })
            ).map((row) => this.project(tx, row)),
          ),
        };
      const plan = await tx.tradingPlan.findUnique({ where: { id: command.planId } });
      if (!plan || plan.goalId !== mandate.goalId) throw new Error("Plan ownership mismatch");
      const action = canonicalFinancialAction(command.action);
      const account = await tx.tradingConnection.findFirst({
        where: { id: mandate.accountId, ownerUserId: actor.ownerUserId, revokedAt: null },
      });
      const instrument = await tx.brokerInstrument.findFirst({
        where: {
          id: action.instrumentId,
          accountId: mandate.accountId,
          brokerSymbol: action.brokerSymbol,
          active: true,
        },
      });
      if (
        !account ||
        !instrument ||
        action.accountId !== mandate.accountId ||
        action.mode !== mandate.mode ||
        action.provider !== account.provider
      )
        throw new Error("Exact account-scoped action required");
      for (const id of command.chartRefs)
        if (
          !(await tx.cloudChart.findFirst({
            where: {
              id,
              ownerUserId: actor.ownerUserId,
              accountId: account.id,
              OR: [{ scope: { in: ["MAIN", "SHARED"] } }, { ownerBotId: bot.id }],
            },
          }))
        )
          throw new Error("Chart evidence outside authorized scope");
      const actionFingerprint = financialActionFingerprint(action);
      const requestKey = createHash("sha256")
        .update(JSON.stringify([scope, operationKey ?? command]))
        .digest("hex");
      const prior = await tx.tradeProposal.findUnique({ where: { requestKey } });
      if (prior) {
        if (
          prior.actionFingerprint !== actionFingerprint ||
          prior.mandateId !== mandate.id ||
          prior.planId !== plan.id ||
          prior.rationaleSummary !== command.rationaleSummary ||
          JSON.stringify(prior.evidenceRefs) !== JSON.stringify(command.evidenceRefs) ||
          JSON.stringify(prior.chartRefs) !== JSON.stringify(command.chartRefs)
        )
          throw new Error("Proposal request identity changed");
        return { result: await this.project(tx, prior) };
      }
      if ((await tx.tradeProposal.count({ where: { ...scope, mandateId: mandate.id } })) >= 1000)
        throw new Error("Proposal capacity reached");
      const row = await tx.tradeProposal.create({
        data: {
          ...scope,
          requestKey,
          accountId: account.id,
          mode: mandate.mode,
          goalId: mandate.goalId,
          mandateId: mandate.id,
          planId: plan.id,
          planVersion: plan.version,
          action,
          actionFingerprint,
          rationaleSummary: command.rationaleSummary,
          evidenceRefs: command.evidenceRefs,
          chartRefs: command.chartRefs,
        },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: actor.ownerUserId,
          accountId: account.id,
          mode: mandate.mode,
          goalId: mandate.goalId,
          mandateId: mandate.id,
          planVersion: plan.version,
          event: "TRADE_PROPOSED",
          entry: {
            version: 1,
            proposalId: row.id,
            actionFingerprint,
            rationaleSummary: command.rationaleSummary,
            evidenceRefs: command.evidenceRefs,
            chartRefs: command.chartRefs,
          },
        },
      });
      return { result: await this.project(tx, row) };
    });
    if (input.result) return input.result;
    const row = input.row;
    if (!row || command.operation !== "preview") throw new Error("Invalid preview request");
    const action = canonicalFinancialAction(row.action);
    const facts = FinancialRiskFactsSchema.parse(
      await this.preflight(actor.ownerUserId, action, signal),
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${row.accountId} FOR UPDATE`;
      await this.main(tx, actor);
      await tx.$queryRaw`SELECT id FROM trade_proposals WHERE id = ${row.id} FOR UPDATE`;
      const current = await tx.tradeProposal.findUniqueOrThrow({ where: { id: row.id } });
      if (current.revision !== command.expectedRevision)
        throw new Error("Proposal revision conflict");
      const mandate = await tx.tradingMandate.findUniqueOrThrow({
        where: { id: current.mandateId },
      });
      const goal = TradingGoalInputSchema.parse(
        (await tx.tradingGoal.findUniqueOrThrow({ where: { id: current.goalId } })).definition,
      );
      const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
      const guard = await tx.accountRiskGuardrail.findUnique({
        where: { accountId_mode: { accountId: row.accountId, mode: row.mode } },
      });
      const limits = guard ? AccountRiskGuardrailsSchema.parse(guard.limits) : null;
      const reservations = await tx.tradingRiskReservation.findMany({
        where: {
          accountId: row.accountId,
          mode: row.mode,
          status: { in: ["RESERVED", "COMMITTED", "UNCERTAIN"] },
        },
        take: 10001,
      });
      if (reservations.length > 10000) throw new Error("Risk ledger capacity exceeded");
      const own = reservations.filter((r) => r.mandateId === mandate.id);
      const sum = (rows: typeof own, key: "risk" | "exposure") =>
        rows.reduce((total, r) => total + financialUnits(r[key].toFixed()), 0n);
      const unresolved = await tx.externalEffect.count({
        where: {
          status: { in: ["executing", "uncertain", "reconciling"] },
          AND: [
            { financialContext: { path: ["accountId"], equals: row.accountId } },
            { financialContext: { path: ["mode"], equals: row.mode } },
          ],
        },
      });
      const state = {
        version: 1 as const,
        missionPnl: mandate.missionPnl.toFixed(),
        dailyPnl: mandate.dailyPnl.toFixed(),
        openRisk: financialDecimal(sum(own, "risk")),
        openNotional: financialDecimal(sum(own, "exposure")),
        positions: own.filter((r) => r.kind === "POSITION").length,
        pendingOrders: own.filter((r) => r.kind === "PENDING").length,
        unresolvedEffects: unresolved > 0,
        missionActive: mandate.status === "ACTIVE",
        accountFrozen: !limits?.autonomousEnabled || Boolean(limits.frozen || guard?.frozen),
      };
      const latest = await tx.tradePreview.findFirst({
        where: { proposalId: row.id },
        orderBy: { version: "desc" },
      });
      if ((latest?.version ?? 0) >= 128) throw new Error("Preview capacity reached");
      let risk = assessFinancialAction({ action, envelope, facts, state, now: this.now() });
      // Management needs provider-owned target attribution, not a guessed model position snapshot.
      if (action.operation !== "OPEN")
        risk = { decision: "DENY", code: "MANAGEMENT_ATTRIBUTION_REQUIRED" };
      if (
        !mandate.observedAt ||
        this.now().getTime() - mandate.observedAt.getTime() > 15000 ||
        mandate.observedAt.getTime() > this.now().getTime() + 2000
      )
        risk = { decision: "DENY", code: "STALE_MISSION_ACCOUNTING" };
      if (
        Date.parse(goal.startsAt) > this.now().getTime() ||
        Date.parse(goal.endsAt) <= this.now().getTime()
      )
        risk = { decision: "DENY", code: "GOAL_WINDOW_INACTIVE" };
      if (risk.decision === "ALLOW" && limits) {
        const code = accountRiskCapacity({
          action,
          mandateId: mandate.id,
          envelope,
          limits,
          facts,
          assessment: risk,
          reservations: reservations.map((r) => ({
            ...r,
            risk: r.risk.toFixed(),
            exposure: r.exposure.toFixed(),
            margin: r.margin.toFixed(),
          })),
        });
        if (code) risk = { decision: "DENY", code };
      }
      const preview = await tx.tradePreview.create({
        data: {
          proposalId: row.id,
          version: (latest?.version ?? 0) + 1,
          action,
          actionFingerprint: current.actionFingerprint,
          facts,
          risk,
          state,
          observedAt: this.now(),
          expiresAt: new Date(this.now().getTime() + 15000),
        },
      });
      const updated = await tx.tradeProposal.update({
        where: { id: row.id },
        data: {
          status: risk.decision === "ALLOW" ? "PREVIEWED" : "BLOCKED",
          revision: { increment: 1 },
        },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: actor.ownerUserId,
          accountId: row.accountId,
          mode: row.mode,
          goalId: row.goalId,
          mandateId: row.mandateId,
          planVersion: row.planVersion,
          event: "TRADE_PREVIEWED",
          entry: {
            version: 1,
            proposalId: row.id,
            previewId: preview.id,
            actionFingerprint: row.actionFingerprint,
            risk,
          },
        },
      });
      return this.project(tx, updated);
    });
  }
}
