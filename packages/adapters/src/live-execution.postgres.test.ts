import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  BrokerReadSession,
  ExecutionProvider,
  ExecutionRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type {
  FinancialAction,
  FinancialRiskFacts,
  TradingMandateEnvelope,
} from "@rakazo/contracts";
import {
  FinancialRiskFactsSchema,
  TradeProposalViewSchema,
  TradingCapabilitiesSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { FINANCIAL_CONTAINMENT_REVISION } from "@rakazo/core";
import {
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import {
  claimBrokerSession,
  createDb,
  heartbeatBrokerSession,
  schemaReadiness,
  withBrokerSessionFence,
} from "@rakazo/db";
import { createLogger, createTestSink } from "@rakazo/logging";
import { makeWorkerUtils } from "graphile-worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerPositionHistory } from "./broker-history.js";
import {
  createBrokerHistoryCache,
  HISTORY_PENDING_TIMEOUT_MS,
  PENDING_HISTORY_READS_PER_TICK,
  readBrokerHistory,
} from "./broker-history.js";
import {
  BrokerStateSchema,
  captureSupervision,
  HISTORY_PENDING,
  observeBrokerState,
  remainingVolume,
} from "./broker-state.js";
import type { ChartActor } from "./cloud-charts.js";
import { FinancialExecution } from "./financial-execution.js";
import { liveReadiness } from "./live-readiness.js";
import { ProviderDispatcher } from "./provider-dispatch.js";
import { ScriptedAutoReviewProvider } from "./scripted-auto-review.js";
import { TradeProposals } from "./trade-proposals.js";
import { TradingMissions } from "./trading-missions.js";
import { TradingOwnerControls } from "./trading-owner-controls.js";
import { TradingRuntimeHealthProbe } from "./trading-runtime-health.js";

const url = process.env.LIVE_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const now = new Date("2026-10-09T10:00:00Z");
const owner = "fixture-owner";
suite("controlled LIVE provider acceptance (PostgreSQL fixtures only)", () => {
  let db: ReturnType<typeof createDb>;
  let envelope: TradingMandateEnvelope;
  let facts: FinancialRiskFacts;
  let action: FinancialAction;
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE trade_previews, trade_proposals, trading_mission_wakes, trading_provider_executions, trading_broker_snapshots, trading_position_histories, trading_position_supervisions, trading_drift_events, trading_runtime_health, simulation_executions, simulation_books, trading_risk_reservations, trading_mandates, trading_plans, trading_goals, account_risk_guardrails, financial_journal, external_effects, trading_connections, organization, deployment_settings CASCADE`;
  beforeAll(() => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("Dedicated fixture _test database required");
    db = createDb(url);
  });
  beforeEach(async () => {
    await reset();
    await db.prisma.deploymentSettings.create({
      data: {
        id: "default",
        singleOwnerEnforced: true,
        ownerUserId: owner,
        ownerSpaceId: "fixture-space",
        ownerBootstrapCompleted: true,
      },
    });
    await db.prisma.organization.create({
      data: { id: "fixture-org", slug: "fixture-org", name: "Fixture", createdAt: now },
    });
    await db.prisma.space.create({
      data: { id: "fixture-space", organizationId: "fixture-org", name: "Fixture" },
    });
    await db.prisma.bot.create({
      data: {
        id: "fixture-main",
        spaceId: "fixture-space",
        userId: owner,
        name: "Fixture",
        color: "blue",
      },
    });
    await db.prisma.thread.create({
      data: {
        id: "fixture-thread",
        botId: "fixture-main",
        userId: owner,
        spaceId: "fixture-space",
      },
    });
    await db.prisma.tradingConnection.create({
      data: {
        id: "fixture-account",
        ownerUserId: owner,
        label: "Fixture",
        providerAccountId: "remote",
        ciphertext: "fixture-unused-ref",
      },
    });
    await db.prisma.brokerInstrument.create({
      data: {
        id: "gold",
        accountId: "fixture-account",
        brokerSymbol: "GOLD.a",
        displayName: "Gold",
        verifiedAt: now,
      },
    });
    envelope = TradingMandateEnvelopeSchema.parse({
      version: 1,
      ownerId: owner,
      botId: "fixture-main",
      accountId: "fixture-account",
      mode: "LIVE",
      expiresAt: "2026-10-10T10:00:00Z",
      allowedInstruments: ["gold"],
      allowedOperations: ["OPEN"],
      maxMissionLoss: "100",
      maxOpenRisk: "60",
      maxRiskPerTrade: "20",
      maxConcurrentPositions: 2,
      maxPendingOrders: 2,
      breachBehavior: "FREEZE",
      expiryBehavior: "FREEZE",
      targetBehavior: "FREEZE",
      currency: "USD",
      allocatedCapital: "2000",
      maxNotional: "10000",
      maxMarginUsagePercent: "50",
      maxDailyLoss: null,
      allowedOrderTypes: ["MARKET", "LIMIT"],
      riskIncreasePermissions: [],
      supervisionPositionId: null,
      supervisedOrderIds: [],
      riskCalculationVersion: "stop-loss-v1",
      costReservePerTrade: "1",
    });
    action = {
      version: 1,
      mode: "LIVE",
      provider: "metaapi",
      accountId: "fixture-account",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
      operation: "OPEN",
      side: "BUY",
      orderType: "MARKET",
      volume: "0.02",
      price: null,
      stopLimitPrice: null,
      expiresAt: null,
      fillingMode: null,
      stopLoss: "2695",
      takeProfit: "2710",
    };
    facts = FinancialRiskFactsSchema.parse({
      version: 1,
      accountId: "fixture-account",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
      currency: "USD",
      connected: true,
      tradingAllowed: true,
      accountMode: "HEDGING",
      observedAt: now.toISOString(),
      equity: "10000",
      freeMargin: "9500",
      margin: "500",
      quote: {
        version: 1,
        provider: "metaapi",
        accountId: "fixture-account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        bid: "2700",
        ask: "2700.1",
        sourceTime: now.toISOString(),
        receivedAt: now.toISOString(),
        revision: "q1",
      },
      tickSize: "0.01",
      lossTickValue: "1",
      contractSize: "100",
      profitCurrency: "USD",
      minVolume: "0.01",
      maxVolume: "100",
      volumeStep: "0.01",
      digits: 2,
      stopsLevel: 10,
      symbolTradingAllowed: true,
      specificationObservedAt: now.toISOString(),
      orderTypes: ["MARKET", "LIMIT"],
      partialClose: true,
      proposedMargin: "30",
      openPositions: [],
      pendingOrders: [],
    });
    await db.prisma.accountRiskGuardrail.create({
      data: {
        accountId: "fixture-account",
        ownerUserId: owner,
        mode: "LIVE",
        limits: {
          version: 1,
          accountId: "fixture-account",
          mode: "LIVE",
          maxReservedRisk: "15",
          maxExposure: "100000",
          maxPendingExposure: "100000",
          maxActiveMandates: 5,
          maxDrawdown: null,
          maxMarginUsagePercent: "50",
          autonomousEnabled: true,
          frozen: false,
          revision: 1,
        },
      },
    });
  });
  afterAll(async () => {
    if (db) {
      await reset();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function claimed(
    id: string,
    envelopePatch: Partial<TradingMandateEnvelope> = {},
    status = "ACTIVE",
  ) {
    const approved = TradingMandateEnvelopeSchema.parse({ ...envelope, ...envelopePatch });
    const threadId =
      approved.botId === "fixture-main" ? "fixture-thread" : `thread-${approved.botId}`;
    if (approved.botId !== "fixture-main") {
      await db.prisma.bot.create({
        data: {
          id: approved.botId,
          userId: owner,
          spaceId: "fixture-space",
          name: approved.botId,
          color: "blue",
        },
      });
      await db.prisma.thread.create({
        data: { id: threadId, botId: approved.botId, userId: owner, spaceId: "fixture-space" },
      });
    }
    const fp = tradingMandateFingerprint(approved);
    await db.prisma.tradingGoal.create({
      data: {
        id: `goal-${id}`,
        ownerUserId: owner,
        botId: approved.botId,
        accountId: "fixture-account",
        mode: approved.mode,
        definition: {
          version: 1,
          accountId: "fixture-account",
          mode: approved.mode,
          objectiveType: approved.supervisionPositionId ? "POSITION_SUPERVISION" : "ATTEMPT_PROFIT",
          targetProfit: "300",
          currency: "USD",
          startsAt: now.toISOString(),
          endsAt: approved.expiresAt,
          allowedInstruments: ["gold"],
          userObjective: "Attempt profit; not guaranteed",
          positionId: approved.supervisionPositionId,
        },
      },
    });
    await db.prisma.tradingPlan.create({
      data: {
        id: `plan-${id}`,
        goalId: `goal-${id}`,
        version: 1,
        definition: {
          version: 1,
          summary: "Fixture bounded plan",
          marketScope: ["gold"],
          monitoring: { watchIds: [], reevaluationAt: [] },
          executionApproach: "Structured execution only",
          riskProposal: (() => {
            const {
              ownerId: _owner,
              botId: _bot,
              accountId: _account,
              mode: _mode,
              ...draft
            } = approved;
            return draft;
          })(),
          evidenceRefs: [],
          chartRefs: [],
        },
      },
    });
    await db.prisma.tradingMandate.create({
      data: {
        id: id,
        ownerUserId: owner,
        botId: approved.botId,
        accountId: "fixture-account",
        mode: approved.mode,
        goalId: `goal-${id}`,
        planId: `plan-${id}`,
        envelope: approved,
        fingerprint: fp,
        approvedFingerprint: status === "ACTIVE" ? fp : null,
        approvedByUserId: status === "ACTIVE" ? owner : null,
        approvedAt: status === "ACTIVE" ? now : null,
        expiresAt: new Date(approved.expiresAt),
        status,
        observedAt: now,
      },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: "fixture-space",
        botId: approved.botId,
        userId: owner,
        threadId,
        prompt: "Fixture",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        taskId: task.id,
        spaceId: "fixture-space",
        botId: approved.botId,
        userId: owner,
        threadId,
        trigger: "user",
        status: "running",
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 120000),
      },
    });
    const actor: ChartActor = {
      ownerUserId: owner,
      botId: approved.botId,
      execution: { runId: run.id, holder: "fixture-worker", generation: 1 },
    };
    return { actor, mandateId: id, planId: `plan-${id}` };
  }

  async function ready(manualPosition = false, manualOrder = false) {
    await db.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { tradingLiveEnabled: true },
    });
    const token = await claimBrokerSession(
      db.prisma,
      "fixture-account",
      "fixture-provider-worker",
      now,
    );
    if (!token) throw new Error("Fixture lease unavailable");
    const capabilities = TradingCapabilitiesSchema.parse({
      version: 1,
      provider: "metaapi",
      accountId: "fixture-account",
      environment: "DEMO",
      accountMode: "HEDGING",
      quotes: true,
      quoteStreaming: true,
      candles: true,
      historicalCandles: true,
      accountEvents: true,
      accountRead: true,
      positionsRead: true,
      ordersRead: true,
      symbolSpecifications: true,
      operations: ["OPEN", "MODIFY_PROTECTION", "CLOSE_POSITION", "CANCEL_ORDER"],
      orderTypes: ["MARKET", "LIMIT"],
      partialClose: true,
      protectiveStops: true,
      nativeOco: false,
      clientReferences: true,
      verifiedAt: now.toISOString(),
      revision: "fixture-v1",
    });
    const schema = await schemaReadiness(db.prisma);
    await withBrokerSessionFence(
      db.prisma,
      token,
      async (tx) => {
        await tx.tradingConnection.update({
          where: { id: "fixture-account" },
          data: { capabilities, verifiedAt: now },
        });
        await tx.brokerSessionLease.update({
          where: { accountId: "fixture-account" },
          data: { state: "CONNECTED", lastHealthyAt: now },
        });
        await tx.brokerInstrument.update({
          where: { id: "gold" },
          data: { specification: { version: 1, verified: true } },
        });
        await tx.tradingRuntimeHealth.create({
          data: {
            containmentRevision: FINANCIAL_CONTAINMENT_REVISION,
            containmentScopeFingerprint: createHash("sha256")
              .update(JSON.stringify([]))
              .digest("hex"),
            containmentActive: true,
            riskHealthy: true,
            effectsHealthy: true,
            emergencyStopHealthy: true,
            observabilityHealthy: true,
            schemaHealthy: schema.healthy,
            schemaFingerprint: schema.expected,
            jobLagMs: 0,
            observedAt: now,
          },
        });
      },
      now,
    );
    const state = BrokerStateSchema.parse({
      account: {
        accountId: "fixture-account",
        currency: "USD",
        balance: "10000",
        equity: "10000",
        freeMargin: "9500",
        margin: "500",
        environment: "DEMO",
        accountMode: "HEDGING",
        platform: "mt5",
        tradingAllowed: true,
        positionValuations: manualPosition ? [{ id: "owner-position", profit: "0" }] : [],
      },
      positions: manualPosition
        ? [
            {
              id: "owner-position",
              accountId: "fixture-account",
              symbol: "GOLD.a",
              side: "BUY",
              volume: "0.02",
              entry: "2700.1",
              stopLoss: "2695",
              takeProfit: "2710",
              clientId: null,
            },
          ]
        : [],
      orders: manualOrder
        ? [
            {
              id: "owner-related-order",
              accountId: "fixture-account",
              symbol: "GOLD.a",
              side: "BUY",
              volume: "0.01",
              orderType: "LIMIT",
              price: "2690",
              stopLimitPrice: null,
              stopLoss: "2685",
              takeProfit: "2710",
              expiresAt: "2026-10-10T09:00:00.000Z",
              clientId: null,
            },
          ]
        : [],
    });
    await observeBrokerState(db.prisma, token, state, now);
    const execute = vi.fn<ExecutionProvider["execute"]>(async (request: ExecutionRequest) => {
      if (request.action.operation === "CANCEL_ORDER") {
        const orderId = request.action.orderId;
        const index = state.orders.findIndex((row) => row.id === orderId);
        if (index < 0) throw new Error("Fixture exact order missing");
        state.orders.splice(index, 1);
        return {
          status: "SUCCEEDED" as const,
          providerReference: request.action.orderId,
          code: "FIXTURE_ACCEPTED",
        };
      }
      if (request.action.operation !== "OPEN") {
        const action = request.action;
        if (action.operation !== "MODIFY_PROTECTION" && action.operation !== "CLOSE_POSITION")
          throw new Error("Fixture unsupported management");
        const index = state.positions.findIndex((row) => row.id === action.positionId);
        const position = state.positions[index];
        if (!position) throw new Error("Fixture exact target missing");
        if (action.operation === "MODIFY_PROTECTION")
          Object.assign(position, { stopLoss: action.stopLoss, takeProfit: action.takeProfit });
        else if (action.volume === null) state.positions.splice(index, 1);
        else position.volume = remainingVolume(position.volume, action.volume);
        return {
          status: "SUCCEEDED" as const,
          providerReference: action.positionId,
          code: "FIXTURE_ACCEPTED",
        };
      }
      state.positions.push({
        id: "fixture-provider-position",
        accountId: "fixture-account",
        symbol: request.action.brokerSymbol,
        side: request.action.side,
        volume: request.action.volume,
        entry: facts.quote.ask,
        stopLoss: request.action.stopLoss,
        takeProfit: request.action.takeProfit,
        clientId: request.clientId,
      });
      return {
        status: "SUCCEEDED" as const,
        providerReference: "fixture-provider-position",
        code: "FIXTURE_ACCEPTED",
      };
    });
    const reconcile = vi.fn(async () => ({
      status: "UNCERTAIN" as const,
      providerReference: null,
      code: "FIXTURE_UNKNOWN",
    }));
    const session: BrokerReadSession = {
      accountId: "fixture-account",
      account: async () => ({ ...state.account, observedAt: now.toISOString() }),
      positions: async () =>
        state.positions.map((row) => ({
          ...row,
          currentPrice: facts.quote.bid,
          profit: "0",
          swap: "0",
          commission: "0",
          observedAt: now.toISOString(),
        })),
      orders: async () => state.orders.map((row) => ({ ...row, observedAt: now.toISOString() })),
      symbols: async () => ["GOLD.a"],
      specification: async () => {
        throw new Error("Fixture unused");
      },
      quote: async () => facts.quote,
      candles: async () => [],
      capabilities: async () => capabilities,
      subscribe: async () => async () => {},
      close: async () => {},
      preflight: async () => facts,
      execution: { execute, reconcile },
    };
    return { token, state, session, execute, reconcile };
  }
  async function prepare(
    id = "live-mandate",
    patch: Partial<TradingMandateEnvelope> = {},
    material = action,
    existing?: Awaited<ReturnType<typeof claimed>>,
  ) {
    const scope = existing ?? (await claimed(id, patch));
    const service = new TradeProposals(
      db.prisma,
      () => now,
      async () => facts,
    );
    const proposal = TradeProposalViewSchema.parse(
      await service.command(
        scope.actor,
        {
          operation: "create",
          mandateId: scope.mandateId,
          planId: scope.planId,
          action: { ...material, mode: "LIVE" },
          rationaleSummary: "Fixture bounded trade",
          evidenceRefs: [],
          chartRefs: [],
        },
        `prepare:${scope.mandateId}:${financialActionFingerprint(material)}`,
      ),
    );
    const preview = TradeProposalViewSchema.parse(
      await service.command(scope.actor, {
        operation: "preview",
        proposalId: proposal.id,
        expectedRevision: 1,
      }),
    );
    if (!preview.preview) throw new Error("Fixture preview unavailable");
    const execution = new FinancialExecution(
      db.prisma,
      () => now,
      async () => facts,
    );
    const run = scope.actor.execution!;
    const context = {
      operationId: "fixture-execute",
      traceId: "fixture",
      spaceId: "fixture-space",
      userId: owner,
      botId: scope.actor.botId!,
      runId: run.runId,
      signal: new AbortController().signal,
    };
    const send = () =>
      execution.execute(
        scope.actor,
        { proposalId: proposal.id, previewId: preview.preview!.id },
        new ScriptedAutoReviewProvider({ decision: "pass", model: "fixture-reviewer" }),
        context,
      );
    return { ...scope, send, execution, proposal, preview };
  }
  it("A: denies LIVE with an exact approved mandate when readiness is incomplete", async () => {
    const row = await prepare();
    await expect(row.send()).rejects.toThrow("LIVE trading disabled");
    expect(await db.prisma.tradingProviderExecution.count()).toBe(0);
    expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
  });
  it("B: approved structured LIVE mutation reaches the fixture provider exactly once", async () => {
    const fixture = await ready();
    const row = await prepare();
    expect(await row.send()).toMatchObject({ status: "STARTED", mode: "LIVE" });
    const dispatcher = new ProviderDispatcher(db.prisma, () => now);
    await dispatcher.tick(fixture.token, fixture.session);
    await dispatcher.tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(
      await db.prisma.externalEffect.findFirst({ where: { kind: "trade_execute" } }),
    ).toMatchObject({
      status: "completed",
      financialProviderReference: "fixture-provider-position",
    });
    expect(await db.prisma.tradingProviderExecution.findFirst()).toMatchObject({
      status: "RESOLVED",
      sentAt: now,
    });
    expect(await db.prisma.financialJournal.count({ where: { event: "STARTED" } })).toBe(1);
  });
  it("C: SIGKILL after provider acceptance reconciles on restart without a second mutation", async () => {
    const fixture = await ready();
    const row = await prepare();
    const started = await row.send();
    const childScript = `
      import { createDb } from '@rakazo/db';
      import { ProviderDispatcher } from './src/provider-dispatch.ts';
      const db = createDb(process.env.LIVE_TEST_DATABASE_URL);
      const fixture = JSON.parse(process.env.FIXTURE_STATE);
      const time = new Date(process.env.FIXTURE_NOW);
      const session = {
        accountId: fixture.token.accountId,
        preflight: async () => fixture.facts,
        execution: { execute: async (request) => {
          const action = request.action;
          const position = { id: 'fixture-provider-position', accountId: action.accountId, symbol: action.brokerSymbol, side: action.side, volume: action.volume, entry: fixture.facts.quote.ask, stopLoss: action.stopLoss, takeProfit: action.takeProfit, clientId: request.clientId };
          await db.pool.query('INSERT INTO fixture_provider_acceptance (effect_id, client_id, position, calls) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT (effect_id) DO UPDATE SET calls=fixture_provider_acceptance.calls+1', [request.effectId, request.clientId, JSON.stringify(position)]);
          console.log('PROVIDER_ACCEPTED');
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        } }
      };
      await new ProviderDispatcher(db.prisma, () => time).tick(fixture.token, session);
    `;
    await db.prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS fixture_provider_acceptance (effect_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, position JSONB NOT NULL, calls INTEGER NOT NULL)",
    );
    await db.prisma.$executeRawUnsafe("TRUNCATE fixture_provider_acceptance");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      {
        cwd: new URL("../", import.meta.url),
        env: {
          PATH: process.env.PATH,
          LIVE_TEST_DATABASE_URL: url,
          FIXTURE_NOW: now.toISOString(),
          FIXTURE_STATE: JSON.stringify({ token: fixture.token, facts }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Provider acceptance fixture timed out")),
          15000,
        );
        child.stdout.on("data", (bytes: Buffer) => {
          if (bytes.toString().includes("PROVIDER_ACCEPTED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Fixture process failed"));
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Fixture exited before provider acceptance"));
        });
      });
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
    expect(child.signalCode).toBe("SIGKILL");
    expect(
      await db.prisma.tradingProviderExecution.findUnique({
        where: { effectId: started.effectId },
      }),
    ).toMatchObject({ status: "SENT" });
    expect(
      await db.prisma.externalEffect.findUnique({ where: { id: started.effectId } }),
    ).toMatchObject({ status: "executing", result: null });
    const accepted = await db.prisma.$queryRaw<
      Array<{ position: unknown; calls: number }>
    >`SELECT position,calls FROM fixture_provider_acceptance WHERE effect_id=${started.effectId}`;
    fixture.state.positions = BrokerStateSchema.shape.positions.parse(
      accepted.map((record) => record.position),
    );
    await db.prisma.brokerSessionLease.update({
      where: { accountId: "fixture-account" },
      data: { expiresAt: now },
    });
    const restarted = await claimBrokerSession(
      db.prisma,
      "fixture-account",
      "fixture-restarted-provider-worker",
      now,
    );
    if (!restarted) throw new Error("Fixture restart lease unavailable");
    fixture.session.execution!.reconcile = vi.fn(async () => ({
      status: "SUCCEEDED" as const,
      providerReference: "fixture-provider-position",
      code: "FIXTURE_RECEIPT_CONFIRMED",
    }));
    await new ProviderDispatcher(db.prisma, () => now).tick(restarted, fixture.session);
    await new ProviderDispatcher(db.prisma, () => now).tick(restarted, fixture.session);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(
      await db.prisma.externalEffect.findUnique({ where: { id: started.effectId } }),
    ).toMatchObject({
      status: "completed",
      financialProviderReference: "fixture-provider-position",
    });
    expect(
      (
        await db.prisma.$queryRaw<
          Array<{ calls: number }>
        >`SELECT calls FROM fixture_provider_acceptance WHERE effect_id=${started.effectId}`
      )[0]?.calls,
    ).toBe(1);
  }, 25000);
  async function supervised(patch: Partial<TradingMandateEnvelope> = {}, manualOrder = false) {
    const fixture = await ready(true, manualOrder);
    const scope = await claimed(
      "supervision-mandate",
      {
        supervisionPositionId: "owner-position",
        allowedOperations: ["MODIFY_PROTECTION", "CLOSE_POSITION"],
        riskIncreasePermissions: [],
        ...patch,
      },
      "AWAITING_APPROVAL",
    );
    await db.prisma.$transaction((tx) =>
      captureSupervision(tx, {
        ownerUserId: owner,
        botId: scope.actor.botId!,
        accountId: "fixture-account",
        mandateId: scope.mandateId,
        positionId: "owner-position",
        now,
      }),
    );
    const mandate = await db.prisma.tradingMandate.findUniqueOrThrow({
      where: { id: scope.mandateId },
    });
    await new TradingMissions(db.prisma, () => now).resolveMandate(owner, {
      id: mandate.id,
      expectedRevision: mandate.revision,
      fingerprint: mandate.fingerprint,
      approve: true,
    });
    facts = {
      ...facts,
      proposedMargin: "0",
      openPositions: [{ id: "owner-position", symbol: "GOLD.a", side: "BUY", volume: "0.02" }],
      pendingOrders: manualOrder
        ? [{ id: "owner-related-order", symbol: "GOLD.a", side: "BUY", volume: "0.01" }]
        : [],
    };
    await db.prisma.tradingMandate.update({ where: { id: mandate.id }, data: { observedAt: now } });
    return { ...fixture, scope };
  }
  const stopAction = (): FinancialAction => ({
    version: 1,
    mode: "LIVE",
    provider: "metaapi",
    accountId: "fixture-account",
    instrumentId: "gold",
    brokerSymbol: "GOLD.a",
    operation: "MODIFY_PROTECTION",
    positionId: "owner-position",
    stopLoss: "2698",
    takeProfit: "2710",
  });
  it("E: owner-approved exact broker position supervision tightens protection through the controlled provider", async () => {
    const fixture = await supervised();
    const row = await prepare(fixture.scope.mandateId, {}, stopAction(), fixture.scope);
    const started = await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.state.positions[0]?.stopLoss).toBe("2698");
    expect(
      await db.prisma.externalEffect.findUnique({ where: { id: started.effectId } }),
    ).toMatchObject({ status: "completed" });
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
    expect(
      await db.prisma.tradingPositionSupervision.findUnique({
        where: { mandateId: fixture.scope.mandateId },
      }),
    ).toMatchObject({ status: "ACTIVE" });
    const entry = await prepare(fixture.scope.mandateId, {}, action, fixture.scope);
    expect(entry.preview.preview?.risk.decision).toBe("DENY");
    await expect(entry.send()).rejects.toThrow();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it("F: external owner stop change pauses supervision and preserves the owner's changed protection", async () => {
    const fixture = await supervised();
    fixture.state.positions[0]!.stopLoss = "2697";
    const drift = await observeBrokerState(db.prisma, fixture.token, fixture.state, now);
    expect(drift).toContain("SUPERVISED_POSITION_CHANGED");
    expect(
      await db.prisma.tradingPositionSupervision.findUnique({
        where: { mandateId: fixture.scope.mandateId },
      }),
    ).toMatchObject({ status: "PAUSED" });
    expect(
      await db.prisma.tradingMandate.findUnique({ where: { id: fixture.scope.mandateId } }),
    ).toMatchObject({ status: "NEEDS_ATTENTION" });
    await expect(
      prepare(fixture.scope.mandateId, {}, stopAction(), fixture.scope),
    ).rejects.toThrow();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.state.positions[0]?.stopLoss).toBe("2697");
    expect(await db.prisma.tradingDriftEvent.count({ where: { resolvedAt: null } })).toBe(1);
  });
  it("D: unknowable provider outcome holds risk and prohibits another send", async () => {
    const fixture = await ready();
    fixture.execute.mockRejectedValue(new Error("sentinel-secret"));
    const row = await prepare();
    await row.send();
    const dispatcher = new ProviderDispatcher(db.prisma, () => now);
    await dispatcher.tick(fixture.token, fixture.session);
    await dispatcher.tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    expect(await db.prisma.tradingProviderExecution.findFirst()).toMatchObject({
      status: "UNCERTAIN",
    });
    expect(await db.prisma.tradingRiskReservation.findFirst()).toMatchObject({
      status: "UNCERTAIN",
    });
    expect(
      await db.prisma.tradingMandate.findUnique({ where: { id: row.mandateId } }),
    ).toMatchObject({ status: "NEEDS_RECONCILIATION" });
    expect(JSON.stringify(await db.prisma.financialJournal.findMany())).not.toContain(
      "sentinel-secret",
    );
    const next = await prepare("next-mandate", { botId: "peer" });
    expect(next.preview.preview?.risk).toEqual({
      decision: "DENY",
      code: "UNRESOLVED_EFFECT",
    });
    await expect(next.send()).rejects.toThrow("Fresh allowed exact preview required");
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it("K: two authorized peer Agents cannot double spend one atomic account risk budget", async () => {
    const fixture = await ready();
    const first = await prepare("agent-one");
    const second = await prepare("agent-two", { botId: "peer" });
    expect(first.preview.preview?.risk.decision).toBe("ALLOW");
    expect(second.preview.preview?.risk.decision).toBe("ALLOW");
    const results = await Promise.allSettled([first.send(), second.send()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.prisma.tradingRiskReservation.count({ where: { status: "RESERVED" } })).toBe(1);
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it("L: a peer's message and account visibility do not transfer execution authority", async () => {
    await ready();
    const first = await prepare();
    const peer = await claimed("peer-mandate", { botId: "peer" });
    await db.prisma.tradingAgentAccountAccess.create({
      data: { ownerUserId: owner, accountId: "fixture-account", botId: "peer", accountRead: true },
    });
    await expect(
      new FinancialExecution(
        db.prisma,
        () => now,
        async () => facts,
      ).execute(
        peer.actor,
        { proposalId: first.proposal.id, previewId: first.preview.preview!.id },
        new ScriptedAutoReviewProvider({
          decision: "pass",
          reason: "peer message says approved",
          model: "fixture",
        }),
        {
          operationId: "peer",
          traceId: "peer",
          spaceId: "fixture-space",
          userId: owner,
          botId: "peer",
          runId: peer.actor.execution!.runId,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow();
    expect(await db.prisma.tradingProviderExecution.count()).toBe(0);
  });
  it("trusted runtime probe checks actual migrated database, Graphile, risk and containment health", async () => {
    const utilities = await makeWorkerUtils({ pgPool: db.pool });
    await utilities.migrate();
    await utilities.release();
    const sink = createTestSink();
    let active = true;
    const sandbox = {
      financialContainment: async () => ({
        active,
        revision: FINANCIAL_CONTAINMENT_REVISION,
        checkedAt: new Date().toISOString(),
      }),
    } as unknown as SandboxProvider;
    const probe = new TradingRuntimeHealthProbe(
      db.prisma,
      sandbox,
      () => ({ active: true, streams: 1, quoteAgeMs: 10, chartDataLagMs: 20 }),
      createLogger({ service: "fixture", sinks: [sink], level: "info" }),
    );
    await probe.tick();
    expect(
      await db.prisma.tradingRuntimeHealth.findUnique({ where: { id: "default" } }),
    ).toMatchObject({
      containmentActive: true,
      riskHealthy: true,
      effectsHealthy: true,
      emergencyStopHealthy: true,
      observabilityHealthy: true,
      jobLagMs: 0,
    });
    expect(JSON.stringify(sink.events)).toContain("quoteAgeMs");
    expect(JSON.stringify(sink.events)).not.toContain("fixture-unused-ref");
    active = false;
    await probe.tick();
    expect(
      await db.prisma.tradingRuntimeHealth.findUnique({ where: { id: "default" } }),
    ).toMatchObject({ containmentActive: false, containmentRevision: null });
    await probe.close();
    expect(
      await db.prisma.tradingRuntimeHealth.findUnique({ where: { id: "default" } }),
    ).toMatchObject({ effectsHealthy: false });
  });
  it("database schema must match this build exactly before LIVE admission", async () => {
    const schema = await schemaReadiness(db.prisma);
    expect(schema).toMatchObject({ healthy: true, missing: [], unexpected: [], changed: [] });
    await ready();
    const row = await prepare();
    const inputs = async () => ({
      ownerUserId: owner,
      botId: "fixture-main",
      mandateId: row.mandateId,
      action,
      facts,
      now,
    });
    expect(await db.prisma.$transaction(async (tx) => liveReadiness(tx, await inputs()))).toEqual({
      ready: true,
      failures: [],
    });
    const latest = await db.prisma.$queryRaw<Array<{ id: string; migration_name: string }>>`
      SELECT id, migration_name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1`;
    // Behind the build: the newest shipped migration was never applied.
    await db.prisma
      .$executeRaw`UPDATE _prisma_migrations SET rolled_back_at = now() WHERE id = ${latest[0]!.id}`;
    try {
      expect((await schemaReadiness(db.prisma)).missing).toEqual([latest[0]!.migration_name]);
      expect(
        (await db.prisma.$transaction(async (tx) => liveReadiness(tx, await inputs()))).failures,
      ).toContain("DATABASE_MIGRATIONS_UNHEALTHY");
    } finally {
      await db.prisma
        .$executeRaw`UPDATE _prisma_migrations SET rolled_back_at = NULL WHERE id = ${latest[0]!.id}`;
    }
    // Ahead of the build or edited after application: a newer schema is never assumed compatible.
    await db.prisma.$executeRaw`
      INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, started_at, applied_steps_count)
      VALUES ('fixture-future', 'fixture', '299912310001_future_build', now(), now(), 1)`;
    try {
      expect((await schemaReadiness(db.prisma)).unexpected).toEqual(["299912310001_future_build"]);
      expect(
        (await db.prisma.$transaction(async (tx) => liveReadiness(tx, await inputs()))).failures,
      ).toContain("DATABASE_MIGRATIONS_UNHEALTHY");
    } finally {
      await db.prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE id = 'fixture-future'`;
    }
    // A health attestation from a Worker running a different build does not count.
    await db.prisma.tradingRuntimeHealth.update({
      where: { id: "default" },
      data: { schemaFingerprint: "different-build" },
    });
    expect(
      (await db.prisma.$transaction(async (tx) => liveReadiness(tx, await inputs()))).failures,
    ).toEqual(["RUNTIME_BUILD_MISMATCH"]);
  });
  it("a broker-side stop-loss exit of an Agent position settles exactly instead of raising drift", async () => {
    const fixture = await ready();
    const row = await prepare();
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
    fixture.state.positions.splice(0, 1);
    fixture.state.account.balance = "9989.5";
    const stopped = closedHistory("fixture-provider-position", {
      profit: "-10.5",
      time: now.toISOString(),
    });
    stopped.deals[1]!.reason = "STOP_LOSS";
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, [stopped]),
    ).toEqual([]);
    expect(await db.prisma.tradingDriftEvent.count()).toBe(0);
    expect(
      await db.prisma.tradingRiskReservation.findFirst({
        where: { providerReference: "fixture-provider-position", kind: "POSITION" },
      }),
    ).toMatchObject({ status: "RELEASED", providerState: null });
    expect(
      await db.prisma.financialJournal.findFirst({ where: { event: "LIVE_PROTECTIVE_EXIT" } }),
    ).toMatchObject({
      entry: expect.objectContaining({ reason: "STOP_LOSS", realizedPnl: "-10.5" }),
    });
    expect(
      await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } }),
    ).toMatchObject({ status: "ACTIVE" });
    expect(
      (
        await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } })
      ).missionPnl.toFixed(),
    ).toBe("-10.5");
    expect(await db.prisma.tradingMissionWake.count({ where: { mandateId: row.mandateId } })).toBe(
      1,
    );
  });
  it("a manual close of an Agent position is drift, not an assumed protective exit", async () => {
    const fixture = await ready();
    const row = await prepare();
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
    fixture.state.positions.splice(0, 1);
    fixture.state.account.balance = "10003";
    const manual = closedHistory("fixture-provider-position", {
      profit: "3",
      time: now.toISOString(),
    });
    manual.deals[1]!.reason = "MANUAL";
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, [manual]),
    ).toEqual(["ATTRIBUTED_POSITION_CLOSED_EXTERNALLY"]);
    expect(
      await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } }),
    ).toMatchObject({ status: "NEEDS_ATTENTION" });
  });
  const pendingEntry: () => FinancialAction = () => ({
    ...action,
    orderType: "LIMIT",
    price: "2699",
    expiresAt: "2026-10-09T12:00:00.000Z",
  });
  async function pendingFixture() {
    const fixture = await ready();
    fixture.execute.mockImplementation(async (request: ExecutionRequest) => {
      const open = request.action;
      if (open.operation !== "OPEN") throw new Error("Fixture expects an entry");
      fixture.state.orders.push({
        id: "fixture-order",
        accountId: "fixture-account",
        symbol: open.brokerSymbol,
        side: open.side,
        volume: open.volume,
        orderType: "LIMIT",
        price: open.price!,
        stopLimitPrice: null,
        stopLoss: open.stopLoss,
        takeProfit: open.takeProfit,
        expiresAt: open.expiresAt,
        clientId: request.clientId,
      });
      return { status: "SUCCEEDED", providerReference: "fixture-order", code: "FIXTURE_ACCEPTED" };
    });
    const row = await prepare("pending-mandate", {}, pendingEntry());
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
    expect(fixture.state.orders).toHaveLength(1);
    return { fixture, row };
  }
  it("an Agent pending entry that expires at its stated time releases its reservation", async () => {
    const { fixture } = await pendingFixture();
    fixture.state.orders.splice(0, 1);
    const later = new Date("2026-10-09T12:00:01Z");
    // The provider session reconnected meanwhile; a reconnect alone is not drift.
    const resumed = await claimBrokerSession(
      db.prisma,
      "fixture-account",
      "fixture-provider-worker",
      later,
    );
    expect(resumed!.generation).toBe(fixture.token.generation + 1);
    expect(await observeBrokerState(db.prisma, resumed!, fixture.state, later)).toEqual([]);
    expect(
      await db.prisma.tradingRiskReservation.findFirstOrThrow({
        where: { providerReference: "fixture-order" },
      }),
    ).toMatchObject({ status: "RELEASED" });
    expect(await db.prisma.financialJournal.count({ where: { event: "LIVE_ORDER_EXPIRED" } })).toBe(
      1,
    );
  });
  it("an Agent pending entry cancelled outside Rakazo before expiry is drift", async () => {
    const { fixture } = await pendingFixture();
    fixture.state.orders.splice(0, 1);
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([
      "ATTRIBUTED_ORDER_CHANGED_EXTERNALLY",
    ]);
  });
  it("an Agent pending entry that fills at the broker keeps exact attribution", async () => {
    const { fixture } = await pendingFixture();
    const admittedRisk = (
      await db.prisma.tradingRiskReservation.findFirstOrThrow({
        where: { providerReference: "fixture-order", kind: "PENDING" },
      })
    ).risk.toFixed();
    const order = fixture.state.orders.splice(0, 1)[0]!;
    fixture.state.positions.push({
      id: order.id,
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      entry: "2699.2",
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      clientId: order.clientId,
    });
    fixture.state.account.positionValuations = [{ id: order.id, profit: "0" }];
    const filled = closedHistory(order.id, { profit: "0", time: now.toISOString() });
    filled.deals.splice(1, 1);
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, [filled]),
    ).toEqual([]);
    const reservation = await db.prisma.tradingRiskReservation.findFirstOrThrow({
      where: { providerReference: order.id },
    });
    expect(reservation).toMatchObject({ kind: "POSITION", status: "COMMITTED" });
    // Adverse fill slippage widens reserved risk; it never shrinks below the admitted amount.
    const admitted = await db.prisma.financialJournal.findFirstOrThrow({
      where: { event: "LIVE_ORDER_FILLED" },
    });
    expect(admitted.entry).toMatchObject({ orderId: order.id, entry: "2699.2" });
    expect(Number(reservation.risk.toFixed())).toBeGreaterThan(Number(admittedRisk));
  });
  it("the owner can retire a permanently uncertain LIVE effect without a claimed outcome", async () => {
    const fixture = await ready();
    const row = await prepare();
    await row.send();
    fixture.execute.mockImplementation(async () => ({
      status: "UNCERTAIN" as const,
      providerReference: null,
      code: "FIXTURE_TIMEOUT",
    }));
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    const execution = await db.prisma.tradingProviderExecution.findFirstOrThrow();
    expect(execution.status).toBe("UNCERTAIN");
    const controls = new TradingOwnerControls(db.prisma, () => now);
    const status = await controls.liveStatus(owner);
    expect(status.accounts[0]?.uncertainEffects).toEqual([
      expect.objectContaining({ effectId: execution.effectId, abandonable: true }),
    ]);
    await expect(controls.abandonUncertainEffect("intruder", execution.effectId)).rejects.toThrow();
    expect(await controls.abandonUncertainEffect(owner, execution.effectId)).toMatchObject({
      requiresReconciliation: true,
    });
    expect(await db.prisma.tradingProviderExecution.findFirstOrThrow()).toMatchObject({
      status: "RESOLVED",
      outcome: expect.objectContaining({ code: "OWNER_ABANDONED_UNKNOWN_OUTCOME" }),
    });
    expect(
      await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } }),
    ).toMatchObject({ status: "CANCELLED" });
    expect(await db.prisma.tradingDriftEvent.count({ where: { resolvedAt: null } })).toBe(1);
    // The retired request is never resent or reconciled again.
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });
  it("mixed manual and Agent exposure on a netting account pauses management and new entries", async () => {
    const fixture = await ready();
    const row = await prepare();
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    fixture.state.account.accountMode = "NETTING";
    fixture.state.positions[0]!.volume = "0.04";
    expect(
      (await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).length,
    ).toBeGreaterThan(0);
    expect(
      await db.prisma.tradingMandate.findUnique({ where: { id: row.mandateId } }),
    ).toMatchObject({ status: "NEEDS_ATTENTION" });
    const next = await prepare("new-entry-after-owner-merge");
    await expect(next.send()).rejects.toThrow();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["-100", "300"])(
    "provider valuation %s creates a durable terminal wake without closing exposure",
    async (profit) => {
      const fixture = await ready();
      const row = await prepare();
      await row.send();
      await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
      fixture.state.account.positionValuations = [{ id: fixture.state.positions[0]!.id, profit }];
      expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
      const status = profit === "-100" ? "RISK_STOPPED" : "TARGET_REACHED";
      expect(
        await db.prisma.tradingMandate.findUnique({ where: { id: row.mandateId } }),
      ).toMatchObject({ status });
      expect(
        await db.prisma.tradingMissionWake.count({
          where: {
            mandateId: row.mandateId,
            kind: "ACCOUNT_EVENT",
            wakeKey: { startsWith: `live:${status}:` },
          },
        }),
      ).toBe(1);
      expect(
        await db.prisma.financialJournal.count({
          where: { mandateId: row.mandateId, event: `LIVE_${status}` },
        }),
      ).toBe(1);
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now);
      expect(fixture.state.positions).toHaveLength(1);
      expect(fixture.execute).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["TP", "PARTIAL_CLOSE", "FULL_CLOSE", "NEW_POSITION", "NETTING_MERGE", "ACCOUNT_CASH"])(
    "detects external %s and pauses exact authority",
    async (kind) => {
      const fixture = await supervised();
      if (kind === "TP") fixture.state.positions[0]!.takeProfit = "2720";
      if (kind === "PARTIAL_CLOSE") fixture.state.positions[0]!.volume = "0.01";
      if (kind === "FULL_CLOSE") fixture.state.positions = [];
      if (kind === "NEW_POSITION")
        fixture.state.positions.push({
          ...fixture.state.positions[0]!,
          id: "another-owner-position",
        });
      if (kind === "NETTING_MERGE") fixture.state.account.accountMode = "NETTING";
      if (kind === "ACCOUNT_CASH") fixture.state.account.balance = "9500";
      expect(
        (await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).length,
      ).toBeGreaterThan(0);
      expect(
        await db.prisma.tradingMandate.findUnique({ where: { id: fixture.scope.mandateId } }),
      ).toMatchObject({ status: "NEEDS_ATTENTION" });
      expect(fixture.execute).not.toHaveBeenCalled();
    },
  );
  it.each([null, "0.01"])(
    "supervises an exact owner position close of volume %s without entry authority",
    async (volume) => {
      const fixture = await supervised();
      const close: FinancialAction = {
        version: 1,
        mode: "LIVE",
        provider: "metaapi",
        accountId: "fixture-account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "CLOSE_POSITION",
        positionId: "owner-position",
        volume,
      };
      const row = await prepare(fixture.scope.mandateId, {}, close, fixture.scope);
      await row.send();
      await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
      expect(fixture.execute).toHaveBeenCalledTimes(1);
      expect(
        await db.prisma.externalEffect.findFirst({ where: { kind: "trade_execute" } }),
      ).toMatchObject({ status: "completed" });
      expect(fixture.state.positions).toHaveLength(volume === null ? 0 : 1);
      if (volume !== null) expect(fixture.state.positions[0]?.volume).toBe("0.01");
    },
  );
  it.each(["FREEZE", "CLOSE_ATTRIBUTED_EXPOSURE"] as const)(
    "emergency stop follows only previously authorized %s behavior",
    async (behavior) => {
      const fixture = await supervised({ emergencyBehavior: behavior });
      const mandate = await db.prisma.tradingMandate.findUniqueOrThrow({
        where: { id: fixture.scope.mandateId },
      });
      await new TradingMissions(db.prisma, () => now).controlMandate(owner, {
        id: mandate.id,
        expectedRevision: mandate.revision,
        action: "EMERGENCY_STOP",
      });
      expect(await db.prisma.accountRiskGuardrail.findFirst()).toMatchObject({ frozen: true });
      const close: FinancialAction = {
        version: 1,
        mode: "LIVE",
        provider: "metaapi",
        accountId: "fixture-account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "CLOSE_POSITION",
        positionId: "owner-position",
        volume: null,
      };
      if (behavior === "FREEZE") {
        const rejected = await prepare(mandate.id, {}, close, fixture.scope);
        expect(rejected.preview.preview?.risk.decision).toBe("DENY");
        await expect(rejected.send()).rejects.toThrow();
        expect(fixture.execute).not.toHaveBeenCalled();
      } else {
        const row = await prepare(mandate.id, {}, close, fixture.scope);
        await row.send();
        await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
        expect(fixture.execute).toHaveBeenCalledTimes(1);
        expect(fixture.state.positions).toHaveLength(0);
      }
    },
  );
  it("retains provider effects, supervision baselines, and drift evidence against ordinary deletion", async () => {
    const fixture = await supervised();
    const row = await prepare(fixture.scope.mandateId, {}, stopAction(), fixture.scope);
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    await expect(db.prisma.tradingProviderExecution.deleteMany()).rejects.toThrow();
    await expect(db.prisma.tradingPositionSupervision.deleteMany()).rejects.toThrow();
    fixture.state.positions[0]!.stopLoss = "2696";
    await observeBrokerState(db.prisma, fixture.token, fixture.state, now);
    await expect(db.prisma.tradingDriftEvent.deleteMany()).rejects.toThrow();
    expect(await db.prisma.tradingProviderExecution.count()).toBe(1);
    expect(await db.prisma.tradingPositionSupervision.count()).toBe(1);
    expect(await db.prisma.tradingDriftEvent.count()).toBe(1);
  });
  it.each([
    "OWNER_LIVE_DISABLED",
    "ACCOUNT_UNVERIFIED",
    "PROVIDER_CONNECTION_UNHEALTHY",
    "CAPABILITY_UNAVAILABLE",
    "SYMBOL_SPECIFICATION_UNVERIFIED",
    "ACCOUNT_STATE_STALE",
    "PRICE_STATE_STALE",
    "RUNTIME_HEALTH_STALE",
    "RISK_ENGINE_UNHEALTHY",
    "EFFECT_SYSTEM_UNHEALTHY",
    "EMERGENCY_STOP_UNHEALTHY",
    "FINANCIAL_CONTAINMENT_UNVERIFIED",
    "OBSERVABILITY_UNHEALTHY",
    "UNRESOLVED_MANUAL_DRIFT",
    "EXACT_LIVE_MANDATE_REQUIRED",
  ])("backend denies %s regardless of an enabled UI", async (code) => {
    const fixture = await ready();
    const scope = await claimed("readiness-mandate");
    if (code === "OWNER_LIVE_DISABLED")
      await db.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { tradingLiveEnabled: false },
      });
    if (code === "ACCOUNT_UNVERIFIED")
      await db.prisma.tradingConnection.update({
        where: { id: "fixture-account" },
        data: { verifiedAt: null },
      });
    if (code === "PROVIDER_CONNECTION_UNHEALTHY")
      await db.prisma.brokerSessionLease.update({
        where: { accountId: "fixture-account" },
        data: { state: "DISCONNECTED" },
      });
    if (code === "CAPABILITY_UNAVAILABLE")
      await db.prisma.tradingConnection.update({
        where: { id: "fixture-account" },
        data: { capabilities: {} },
      });
    if (code === "SYMBOL_SPECIFICATION_UNVERIFIED")
      await db.prisma.brokerInstrument.update({ where: { id: "gold" }, data: { active: false } });
    if (code === "ACCOUNT_STATE_STALE")
      await db.prisma.tradingBrokerSnapshot.update({
        where: { accountId: "fixture-account" },
        data: { observedAt: new Date(now.getTime() - 20000) },
      });
    if (code === "PRICE_STATE_STALE")
      facts = {
        ...facts,
        quote: { ...facts.quote, sourceTime: new Date(now.getTime() - 20000).toISOString() },
      };
    if (code === "RUNTIME_HEALTH_STALE")
      await db.prisma.tradingRuntimeHealth.update({
        where: { id: "default" },
        data: { observedAt: new Date(now.getTime() - 20000) },
      });
    if (code === "RISK_ENGINE_UNHEALTHY")
      await db.prisma.tradingRuntimeHealth.update({
        where: { id: "default" },
        data: { riskHealthy: false },
      });
    if (code === "EFFECT_SYSTEM_UNHEALTHY")
      await db.prisma.tradingRuntimeHealth.update({
        where: { id: "default" },
        data: { effectsHealthy: false },
      });
    if (code === "EMERGENCY_STOP_UNHEALTHY")
      await db.prisma.tradingRuntimeHealth.update({
        where: { id: "default" },
        data: { emergencyStopHealthy: false },
      });
    if (code === "FINANCIAL_CONTAINMENT_UNVERIFIED")
      await db.prisma.tradingRuntimeHealth.update({
        where: { id: "default" },
        data: { containmentScopeFingerprint: "wrong-scope" },
      });
    if (code === "OBSERVABILITY_UNHEALTHY")
      await db.prisma.tradingRuntimeHealth.update({
        where: { id: "default" },
        data: { jobLagMs: 30001 },
      });
    if (code === "UNRESOLVED_MANUAL_DRIFT")
      await db.prisma.tradingDriftEvent.create({
        data: {
          ownerUserId: owner,
          accountId: "fixture-account",
          reason: "fixture",
          evidence: { version: 1 },
        },
      });
    if (code === "EXACT_LIVE_MANDATE_REQUIRED")
      await db.prisma.tradingMandate.update({
        where: { id: scope.mandateId },
        data: { status: "PAUSED" },
      });
    const status = await db.prisma.$transaction((tx) =>
      liveReadiness(tx, {
        ownerUserId: owner,
        botId: scope.actor.botId!,
        mandateId: scope.mandateId,
        action,
        facts,
        now,
      }),
    );
    expect(status.ready).toBe(false);
    expect(status.failures).toContain(code);
    expect(fixture.execute).not.toHaveBeenCalled();
  });
  it("owner LIVE enablement is explicit, audited, and never available to peers", async () => {
    const controls = new TradingOwnerControls(db.prisma, () => now);
    expect(await controls.liveSettings(owner)).toEqual({ enabled: false });
    await expect(controls.setLiveEnabled("peer", true)).rejects.toThrow();
    expect(await controls.setLiveEnabled(owner, true)).toEqual({ enabled: true });
    expect(
      await db.prisma.financialJournal.count({ where: { event: "OWNER_LIVE_PRODUCT_ENABLEMENT" } }),
    ).toBe(1);
    const row = await prepare();
    await expect(row.send()).rejects.toThrow("LIVE trading disabled");
    expect(await db.prisma.tradingProviderExecution.count()).toBe(0);
  });
  it("owner drift reconciliation cancels old authority and requires a new exact supervision proposal", async () => {
    const fixture = await supervised();
    fixture.state.positions[0]!.stopLoss = "2697";
    await observeBrokerState(db.prisma, fixture.token, fixture.state, now);
    const snapshot = await db.prisma.tradingBrokerSnapshot.findUniqueOrThrow({
      where: { accountId: "fixture-account" },
    });
    const controls = new TradingOwnerControls(db.prisma, () => now);
    await expect(
      controls.reconcileDrift(owner, "fixture-account", snapshot.revision - 1),
    ).rejects.toThrow("Exact fresh");
    expect(
      await controls.reconcileDrift(owner, "fixture-account", snapshot.revision),
    ).toMatchObject({ requiresNewMandate: true });
    expect(
      await db.prisma.tradingMandate.findUnique({ where: { id: fixture.scope.mandateId } }),
    ).toMatchObject({ status: "CANCELLED" });
    expect(await db.prisma.tradingDriftEvent.count({ where: { resolvedAt: null } })).toBe(0);
    expect(fixture.state.positions[0]!.stopLoss).toBe("2697");
    expect(fixture.execute).not.toHaveBeenCalled();
    const next = await claimed(
      "new-owner-supervision",
      { supervisionPositionId: "owner-position", allowedOperations: ["MODIFY_PROTECTION"] },
      "AWAITING_APPROVAL",
    );
    await db.prisma.$transaction((tx) =>
      captureSupervision(tx, {
        ownerUserId: owner,
        botId: next.actor.botId!,
        accountId: "fixture-account",
        mandateId: next.mandateId,
        positionId: "owner-position",
        now,
      }),
    );
    expect(await db.prisma.tradingPositionSupervision.count()).toBe(2);
  });
  it("exact synchronized provider deal history reconciles realized owner-position PnL without manual drift", async () => {
    const fixture = await supervised();
    const close: FinancialAction = {
      version: 1,
      mode: "LIVE",
      provider: "metaapi",
      accountId: "fixture-account",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
      operation: "CLOSE_POSITION",
      positionId: "owner-position",
      volume: null,
    };
    const row = await prepare(fixture.scope.mandateId, {}, close, fixture.scope);
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(
      await db.prisma.tradingMandate.findUnique({ where: { id: row.mandateId } }),
    ).toMatchObject({ observedAt: null });
    fixture.state.account.balance = "9994";
    const history = {
      accountId: "fixture-account",
      positionId: "owner-position",
      synchronized: true,
      deals: [
        {
          id: "owner-entry-deal",
          positionId: "owner-position",
          entry: "IN" as const,
          time: new Date(now.getTime() - 1000).toISOString(),
          volume: "0.02",
          profit: "0",
          commission: "0",
          swap: "0",
        },
        {
          id: "approved-exit-deal",
          positionId: "owner-position",
          entry: "OUT" as const,
          time: now.toISOString(),
          volume: "0.02",
          profit: "-5",
          commission: "-1",
          swap: "0",
        },
      ],
    };
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, [history]),
    ).toEqual([]);
    expect(
      await db.prisma.tradingMandate.findUnique({ where: { id: row.mandateId } }),
    ).toMatchObject({ observedAt: now, missionPnl: expect.anything() });
    expect(
      (
        await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } })
      ).missionPnl.toFixed(),
    ).toBe("-6");
    expect(
      await db.prisma.financialJournal.count({ where: { event: "PROVIDER_POSITION_HISTORY" } }),
    ).toBe(1);
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, [
        { ...history, deals: [...history.deals].reverse() },
      ]),
    ).toEqual([]);
    expect(
      await db.prisma.financialJournal.count({ where: { event: "PROVIDER_POSITION_HISTORY" } }),
    ).toBe(1);
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, [
        { ...history, deals: history.deals.map((deal) => ({ ...deal, profit: "-100" })) },
      ]),
    ).toContain("PROVIDER_HISTORY_CONFLICT");
  });
  it.each(["CANCEL_PENDING", "FREEZE"] as const)(
    "supervision permits exact related order cancellation only with %s emergency authority",
    async (behavior) => {
      const fixture = await supervised(
        {
          allowedOperations: ["MODIFY_PROTECTION", "CLOSE_POSITION", "CANCEL_ORDER"],
          supervisedOrderIds: ["owner-related-order"],
          emergencyBehavior: behavior,
        },
        true,
      );
      const mandate = await db.prisma.tradingMandate.findUniqueOrThrow({
        where: { id: fixture.scope.mandateId },
      });
      await new TradingMissions(db.prisma, () => now).controlMandate(owner, {
        id: mandate.id,
        expectedRevision: mandate.revision,
        action: "EMERGENCY_STOP",
      });
      const cancel: FinancialAction = {
        version: 1,
        mode: "LIVE",
        provider: "metaapi",
        accountId: "fixture-account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "CANCEL_ORDER",
        orderId: "owner-related-order",
      };
      const row = await prepare(mandate.id, {}, cancel, fixture.scope);
      if (behavior === "FREEZE") {
        expect(row.preview.preview?.risk.decision).toBe("DENY");
        await expect(row.send()).rejects.toThrow();
        expect(fixture.execute).not.toHaveBeenCalled();
      } else {
        await row.send();
        await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
        expect(fixture.execute).toHaveBeenCalledTimes(1);
        expect(fixture.state.orders).toHaveLength(0);
        expect(fixture.state.positions).toHaveLength(1);
        expect(await db.prisma.tradingPositionSupervision.findFirst()).toMatchObject({
          status: "ACTIVE",
        });
        expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
      }
    },
  );
  const closedHistory = (
    positionId: string,
    exit: { profit: string; time: string },
  ): BrokerPositionHistory => ({
    accountId: "fixture-account",
    positionId,
    synchronized: true,
    deals: [
      {
        id: `${positionId}-in`,
        positionId,
        entry: "IN",
        time: new Date(now.getTime() - 3_600_000).toISOString(),
        volume: "0.02",
        profit: "0",
        commission: "0",
        swap: "0",
      },
      {
        id: `${positionId}-out`,
        positionId,
        entry: "OUT",
        time: exit.time,
        volume: "0.02",
        profit: exit.profit,
        commission: "0",
        swap: "0",
      },
    ],
  });
  it("provider history progresses past 100 attributed positions within a fixed per-tick read budget", async () => {
    const fixture = await ready();
    const scope = await claimed("history-mandate");
    const stale = new Date(now.getTime() - 86_400_000);
    await db.prisma.tradingRiskReservation.createMany({
      data: Array.from({ length: 150 }, (_, index) => ({
        ownerUserId: owner,
        accountId: "fixture-account",
        mode: "LIVE",
        mandateId: scope.mandateId,
        effectId: `historical-effect-${index}`,
        actionFingerprint: "historical",
        kind: "POSITION",
        risk: "0",
        exposure: "0",
        margin: "0",
        status: "RELEASED",
        executionGeneration: 1,
        providerReference: `historical-${String(index).padStart(3, "0")}`,
        createdAt: stale,
        updatedAt: stale,
      })),
    });
    const positionHistory = vi.fn(async (positionId: string) =>
      closedHistory(positionId, { profit: "1", time: stale.toISOString() }),
    );
    const session = { ...fixture.session, positionHistory };
    const cache = createBrokerHistoryCache();
    let ticks = 0;
    while ((await db.prisma.tradingPositionHistory.count()) < 150) {
      ticks++;
      if (ticks > 40) throw new Error("History reads made no progress");
      const before = positionHistory.mock.calls.length;
      const read = await readBrokerHistory(db.prisma, session, fixture.state, cache, now);
      expect(read.missing).toEqual([]);
      expect(read.histories.length).toBeGreaterThan(0);
      expect(positionHistory.mock.calls.length - before).toBeLessThanOrEqual(
        PENDING_HISTORY_READS_PER_TICK + 1,
      );
      expect(
        await observeBrokerState(db.prisma, fixture.token, fixture.state, now, read.histories),
      ).toEqual([]);
    }
    expect(await db.prisma.tradingPositionHistory.count({ where: { complete: true } })).toBe(150);
    expect(
      await db.prisma.financialJournal.count({ where: { event: "PROVIDER_POSITION_HISTORY" } }),
    ).toBe(150);
    // Old deals were already reflected in the observed balance; nothing is double counted.
    expect(await db.prisma.tradingDriftEvent.count()).toBe(0);
    const settled = positionHistory.mock.calls.length;
    const idle = await readBrokerHistory(db.prisma, session, fixture.state, cache, now);
    expect(idle).toEqual({ histories: [], missing: [] });
    expect(positionHistory.mock.calls.length).toBe(settled);
  });
  it("a closed attributed position defers the observation until its exact history explains the balance", async () => {
    const fixture = await ready();
    const row = await prepare();
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
    const snapshot = await db.prisma.tradingBrokerSnapshot.findUniqueOrThrow({
      where: { accountId: "fixture-account" },
    });
    fixture.state.positions.splice(0, 1);
    fixture.state.account.balance = "9994";
    let available = false;
    const positionHistory = vi.fn(async (positionId: string) => {
      if (!available) throw Object.assign(new Error("fixture"), { statusCode: 503 });
      const history = closedHistory(positionId, { profit: "-6", time: now.toISOString() });
      history.deals[1]!.reason = "STOP_LOSS";
      return history;
    });
    const session = { ...fixture.session, positionHistory };
    const cache = createBrokerHistoryCache();
    const pending = await readBrokerHistory(db.prisma, session, fixture.state, cache, now);
    expect(pending.missing).toEqual(["fixture-provider-position"]);
    expect(
      await observeBrokerState(
        db.prisma,
        fixture.token,
        fixture.state,
        now,
        pending.histories,
        pending.missing,
      ),
    ).toEqual([HISTORY_PENDING]);
    expect(
      await db.prisma.tradingBrokerSnapshot.findUniqueOrThrow({
        where: { accountId: "fixture-account" },
      }),
    ).toMatchObject({ revision: snapshot.revision });
    expect(await db.prisma.tradingDriftEvent.count()).toBe(0);
    available = true;
    const explained = await readBrokerHistory(db.prisma, session, fixture.state, cache, now);
    expect(explained.missing).toEqual([]);
    expect(
      await observeBrokerState(
        db.prisma,
        fixture.token,
        fixture.state,
        now,
        explained.histories,
        explained.missing,
      ),
    ).toEqual([]);
    expect(
      (
        await db.prisma.tradingPositionHistory.findUniqueOrThrow({
          where: {
            accountId_positionId: {
              accountId: "fixture-account",
              positionId: "fixture-provider-position",
            },
          },
        })
      ).realizedPnl?.toFixed(),
    ).toBe("-6");
    expect(
      (
        await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } })
      ).missionPnl.toFixed(),
    ).toBe("-6");
    // Accounting keeps using the persisted exact history; it is not reread every observation.
    const reads = positionHistory.mock.calls.length;
    const later = await readBrokerHistory(db.prisma, session, fixture.state, cache, now);
    expect(
      await observeBrokerState(db.prisma, fixture.token, fixture.state, now, later.histories),
    ).toEqual([]);
    expect(positionHistory.mock.calls.length).toBe(reads);
  });
  it("required history that never arrives becomes owner-visible drift after the timeout", async () => {
    const fixture = await ready();
    const row = await prepare();
    await row.send();
    await new ProviderDispatcher(db.prisma, () => now).tick(fixture.token, fixture.session);
    expect(await observeBrokerState(db.prisma, fixture.token, fixture.state, now)).toEqual([]);
    fixture.state.positions.splice(0, 1);
    fixture.state.account.balance = "9994";
    const positionHistory = vi.fn(async () => {
      throw Object.assign(new Error("fixture"), { statusCode: 429 });
    });
    const session = { ...fixture.session, positionHistory };
    const cache = createBrokerHistoryCache();
    const later = new Date(now.getTime() + HISTORY_PENDING_TIMEOUT_MS + 1000);
    for (let at = 20_000; at < later.getTime() - now.getTime(); at += 20_000)
      await heartbeatBrokerSession(db.prisma, fixture.token, new Date(now.getTime() + at));
    const read = await readBrokerHistory(db.prisma, session, fixture.state, cache, later);
    expect(read.missing).toEqual(["fixture-provider-position"]);
    expect(positionHistory).toHaveBeenCalledTimes(1);
    const reasons = await observeBrokerState(
      db.prisma,
      fixture.token,
      fixture.state,
      later,
      read.histories,
      read.missing,
    );
    expect(reasons).toContain("PROVIDER_HISTORY_UNAVAILABLE");
    expect(reasons).toContain("ACCOUNT_STATE_CHANGED");
    expect(await db.prisma.tradingDriftEvent.count({ where: { resolvedAt: null } })).toBe(1);
    expect(
      await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: row.mandateId } }),
    ).toMatchObject({ status: "NEEDS_ATTENTION" });
  });
});
