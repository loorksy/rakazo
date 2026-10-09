import type { BrokerQuote, FinancialRiskFacts } from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  FinancialEffectContextSchema,
  FinancialEffectOutcomeSchema,
  FinancialRiskFactsSchema,
  PositiveTradingDecimalSchema,
  SimulationBookStateSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import {
  applySimulationAction,
  financialDecimal,
  financialUnits,
  MAIN_TRADING_AGENT_SPAWN_KEY,
  valueSimulationBook,
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

/** Local provider adapter. No broker mutation SDK or credential resolver is imported. */
export class SimulationBroker {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async principal(tx: Prisma.TransactionClient, actor: ChartActor, accountId: string) {
    await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${accountId} FOR UPDATE`;
    await fenceChartExecution(tx, actor);
    if (!actor.execution || !actor.botId) throw new Error("Claimed simulation execution required");
    const settings = await tx.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
    if (
      !settings.singleOwnerEnforced ||
      settings.ownerUserId !== actor.ownerUserId ||
      !(await tx.bot.findFirst({
        where: {
          id: actor.botId,
          userId: actor.ownerUserId,
          spaceId: settings.ownerSpaceId ?? "",
          spawnKey: MAIN_TRADING_AGENT_SPAWN_KEY,
        },
      }))
    )
      throw new Error("Main simulation principal required");
    if (
      !(await tx.tradingConnection.findFirst({
        where: { id: accountId, ownerUserId: actor.ownerUserId, revokedAt: null },
      }))
    )
      throw new Error("Simulation account unavailable");
  }
  /** Trusted inputs only; model tools cannot supply account or quote facts. */
  async preflight(
    actor: ChartActor,
    rawFacts: FinancialRiskFacts,
    otherQuotes: BrokerQuote[] = [],
  ): Promise<FinancialRiskFacts> {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const facts = FinancialRiskFactsSchema.parse(rawFacts);
    for (const time of [facts.observedAt, facts.quote.sourceTime, facts.quote.receivedAt]) {
      const age = this.now().getTime() - Date.parse(time);
      if (age < -2000 || age > 15000) throw new Error("Fresh simulation source required");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.principal(tx, actor, facts.accountId);
      let book = await tx.simulationBook.findUnique({ where: { accountId: facts.accountId } });
      if (!book) {
        const equity = PositiveTradingDecimalSchema.parse(facts.equity);
        book = await tx.simulationBook.create({
          data: {
            accountId: facts.accountId,
            ownerUserId: actor.ownerUserId,
            state: {
              version: 1,
              accountId: facts.accountId,
              mode: "SIMULATION",
              currency: facts.currency,
              initialEquity: equity,
              balance: equity,
              positions: [],
              orders: [],
              performance: [],
            },
          },
        });
      }
      if (book.ownerUserId !== actor.ownerUserId) throw new Error("Simulation book unavailable");
      const state = SimulationBookStateSchema.parse(book.state);
      if (state.currency !== facts.currency || state.accountId !== facts.accountId)
        throw new Error("Simulation currency changed");
      const value = valueSimulationBook(state, [facts.quote, ...otherQuotes], this.now());
      const mandates = await tx.tradingMandate.findMany({
        where: {
          ownerUserId: actor.ownerUserId,
          botId: actor.botId,
          accountId: facts.accountId,
          mode: "SIMULATION",
        },
        take: 1001,
      });
      if (mandates.length > 1000) throw new Error("Simulation accounting capacity exceeded");
      const day = this.now().toISOString().slice(0, 10);
      for (const mandate of mandates) {
        const performance = state.performance.find((row) => row.mandateId === mandate.id);
        const unrealized = value.unrealized.get(mandate.id) ?? 0n;
        await tx.tradingMandate.update({
          where: { id: mandate.id },
          data: {
            missionPnl: financialDecimal(financialUnits(performance?.realized ?? "0") + unrealized),
            dailyPnl: financialDecimal(
              financialUnits(performance?.day === day ? performance.dailyRealized : "0") +
                unrealized,
            ),
            observedAt: this.now(),
            observedState: {
              version: 1,
              source: "simulation-v1",
              bookRevision: book.revision,
              positionIds: state.positions
                .filter((row) => row.mandateId === mandate.id)
                .map((row) => row.id),
              orderIds: state.orders
                .filter((row) => row.mandateId === mandate.id)
                .map((row) => row.id),
            },
          },
        });
      }
      return FinancialRiskFactsSchema.parse({
        ...facts,
        simulationRevision: book.revision,
        equity: value.equity,
        margin: value.margin,
        freeMargin: value.freeMargin,
        openPositions: state.positions.map((row) => ({
          id: row.id,
          symbol: row.brokerSymbol,
          side: row.side,
          volume: row.volume,
        })),
        pendingOrders: state.orders.map((row) => ({
          id: row.id,
          symbol: row.brokerSymbol,
          side: row.side,
          volume: row.volume,
        })),
      });
    });
  }
  /** Current STARTED/reserved effects only. Repeated calls return the immutable provider receipt. */
  async execute(actor: ChartActor, effectId: string, rawFacts: FinancialRiskFacts) {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const facts = FinancialRiskFactsSchema.parse(rawFacts);
    return this.prisma.$transaction(async (tx) => {
      await this.principal(tx, actor, facts.accountId);
      await tx.$queryRaw`SELECT id FROM external_effects WHERE id = ${effectId} FOR UPDATE`;
      const effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: effectId } });
      const context = FinancialEffectContextSchema.parse(effect.financialContext);
      const action = canonicalFinancialAction(effect.request);
      if (
        context.version !== 2 ||
        context.mode !== "SIMULATION" ||
        action.mode !== "SIMULATION" ||
        context.accountId !== facts.accountId ||
        context.ownerUserId !== actor.ownerUserId ||
        context.botId !== actor.botId ||
        effect.runId !== actor.execution?.runId ||
        effect.financialGeneration !== actor.execution?.generation ||
        effect.financialHolder !== actor.execution?.holder ||
        financialActionFingerprint(action) !== context.actionFingerprint
      )
        throw new Error("Exact current simulation effect required");
      const prior = await tx.simulationExecution.findUnique({ where: { effectId } });
      if (prior) {
        if (
          prior.ownerUserId !== actor.ownerUserId ||
          prior.accountId !== context.accountId ||
          prior.actionFingerprint !== context.actionFingerprint
        )
          throw new Error("Simulation receipt binding mismatch");
        return FinancialEffectOutcomeSchema.parse(prior.outcome);
      }
      if (
        effect.status !== "executing" ||
        !effect.financialStartedAt ||
        !effect.financialExpiresAt ||
        effect.financialExpiresAt <= this.now()
      )
        throw new Error("STARTED simulation effect required");
      const mandate = await tx.tradingMandate.findUniqueOrThrow({
        where: { id: context.authorizationId },
      });
      const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
      const guard = await tx.accountRiskGuardrail.findUnique({
        where: { accountId_mode: { accountId: context.accountId, mode: "SIMULATION" } },
      });
      const limits = guard ? AccountRiskGuardrailsSchema.parse(guard.limits) : null;
      if (
        mandate.status !== "ACTIVE" ||
        mandate.expiresAt <= this.now() ||
        mandate.approvedByUserId !== actor.ownerUserId ||
        mandate.approvedFingerprint !== tradingMandateFingerprint(envelope) ||
        guard?.frozen ||
        !limits?.autonomousEnabled ||
        limits.frozen ||
        limits.accountId !== context.accountId ||
        limits.mode !== "SIMULATION" ||
        limits.revision !== guard?.revision ||
        guard?.ownerUserId !== actor.ownerUserId ||
        action.operation !== "OPEN"
      )
        throw new Error("Current simulation authority required");
      const reservation = await tx.tradingRiskReservation.findUnique({ where: { effectId } });
      if (
        reservation?.status !== "RESERVED" ||
        reservation.accountId !== context.accountId ||
        reservation.mode !== "SIMULATION" ||
        reservation.mandateId !== mandate.id ||
        reservation.executionGeneration !== actor.execution?.generation
      )
        throw new Error("Current simulation risk reservation required");
      const book = await tx.simulationBook.findUniqueOrThrow({
        where: { accountId: context.accountId },
      });
      if (book.ownerUserId !== actor.ownerUserId || book.revision !== facts.simulationRevision)
        throw new Error("Simulation book revision conflict");
      const before = SimulationBookStateSchema.parse(book.state);
      const result = applySimulationAction({
        state: before,
        action,
        facts,
        now: this.now(),
        attribution: {
          effectId,
          mandateId: context.authorizationId,
          goalId: context.goalId,
          planVersion: context.planVersion,
        },
      });
      await tx.simulationBook.update({
        where: { accountId: book.accountId },
        data: { state: result.state, revision: { increment: 1 } },
      });
      await tx.simulationExecution.create({
        data: {
          effectId,
          accountId: context.accountId,
          ownerUserId: actor.ownerUserId,
          mandateId: context.authorizationId,
          actionFingerprint: context.actionFingerprint,
          outcome: result.outcome,
          changes: {
            version: 1,
            operation: action.operation,
            balanceBefore: before.balance,
            balanceAfter: result.state.balance,
            reference: result.outcome.providerReference,
            releasedEffectIds: result.releasedEffectIds,
          },
        },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: actor.ownerUserId,
          accountId: context.accountId,
          mode: "SIMULATION",
          effectId,
          goalId: context.goalId,
          mandateId: context.authorizationId,
          planVersion: context.planVersion,
          event: "SIMULATION_ACCEPTED",
          entry: {
            version: 1,
            actionFingerprint: context.actionFingerprint,
            providerReference: result.outcome.providerReference,
            bookRevision: book.revision + 1,
          },
        },
      });
      return result.outcome;
    });
  }
  /** Trusted reconciliation reads only, never resends. */
  async receipt(ownerUserId: string, effectId: string) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const row = await this.prisma.simulationExecution.findFirst({
      where: { effectId, ownerUserId },
    });
    return row ? FinancialEffectOutcomeSchema.parse(row.outcome) : null;
  }
}
