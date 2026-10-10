import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { BrokerReadSession, ExecutionRequest } from "@rakazo/adapter-kit";
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
import {
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import { claimBrokerSession, createDb, withBrokerSessionFence } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrokerStateSchema,
  captureSupervision,
  observeBrokerState,
  remainingVolume,
} from "./broker-state.js";
import type { ChartActor } from "./cloud-charts.js";
import { FinancialExecution } from "./financial-execution.js";
import { ProviderDispatcher } from "./provider-dispatch.js";
import { ScriptedAutoReviewProvider } from "./scripted-auto-review.js";
import { TradeProposals } from "./trade-proposals.js";
import { TradingMissions } from "./trading-missions.js";

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
      .$executeRaw`TRUNCATE trade_previews, trade_proposals, trading_mission_wakes, trading_provider_executions, trading_broker_snapshots, trading_position_supervisions, trading_drift_events, trading_runtime_health, simulation_executions, simulation_books, trading_risk_reservations, trading_mandates, trading_plans, trading_goals, account_risk_guardrails, financial_journal, external_effects, trading_connections, organization, deployment_settings CASCADE`;
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

  async function ready(manualPosition = false) {
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
            containmentRevision: "financial-egress-v1",
            containmentScopeFingerprint: createHash("sha256")
              .update(JSON.stringify([]))
              .digest("hex"),
            containmentActive: true,
            riskHealthy: true,
            effectsHealthy: true,
            emergencyStopHealthy: true,
            observabilityHealthy: true,
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
      orders: [],
    });
    await observeBrokerState(db.prisma, token, state, now);
    const execute = vi.fn(async (request: ExecutionRequest) => {
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
      orders: async () => [],
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
        `prepare:${financialActionFingerprint(material)}`,
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
  async function supervised(patch: Partial<TradingMandateEnvelope> = {}) {
    const fixture = await ready(true);
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
});
