import { spawn } from "node:child_process";
import type { BrokerEvent, BrokerProvider, BrokerReadSession } from "@rakazo/adapter-kit";
import type {
  AccountRiskGuardrails,
  FinancialAction,
  FinancialRiskFacts,
  TradingMandateEnvelope,
  TradingPlanInput,
} from "@rakazo/contracts";
import {
  SimulationBookStateSchema,
  TradeProposalViewSchema,
  TradingCapabilitiesSchema,
  TradingGoalViewSchema,
  TradingMandateViewSchema,
  TradingPlanViewSchema,
} from "@rakazo/contracts";
import { answerRunInput, claimBrokerSession, createDb, withBrokerSessionFence } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerConnectionSupervisor } from "./broker-supervisor.js";
import type { ChartActor } from "./cloud-charts.js";
import { FinancialEffects } from "./financial-effects.js";
import { FinancialExecution } from "./financial-execution.js";
import { createJobReconciler } from "./job-reconciler.js";
import { ScriptedAutoReviewProvider } from "./scripted-auto-review.js";
import { EncryptedSecretStore } from "./secrets.js";
import { SimulationBroker } from "./simulation-broker.js";
import {
  enqueueSimulationExpiries,
  expireSimulationAccount,
  observeSimulationAccount,
} from "./simulation-market.js";
import { TradeProposals } from "./trade-proposals.js";
import { enqueueMissionWakes, wakeTradingMission } from "./trading-mission-wakes.js";
import { TradingMissions } from "./trading-missions.js";

const url = process.env.MISSION_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const now = new Date("2026-10-09T10:00:00Z");
const owner = "fixture-owner";
const human: ChartActor = { ownerUserId: owner };
const actor: ChartActor = {
  ...human,
  botId: "main",
  execution: { runId: "claimed", holder: "worker-a", generation: 1 },
};
const goal = {
  version: 1 as const,
  accountId: "account",
  mode: "SIMULATION" as const,
  objectiveType: "ATTEMPT_PROFIT" as const,
  targetProfit: "300",
  currency: "USD",
  startsAt: now.toISOString(),
  endsAt: "2026-10-11T10:00:00Z",
  allowedInstruments: ["gold"],
  userObjective: "Attempt a profit within approved hard risk limits",
  positionId: null,
};
const draft: Omit<TradingMandateEnvelope, "ownerId" | "botId" | "accountId" | "mode"> = {
  version: 1,
  expiresAt: goal.endsAt,
  allowedInstruments: ["gold"],
  allowedOperations: ["OPEN", "CLOSE_POSITION"],
  maxMissionLoss: "100",
  maxOpenRisk: "40",
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
};
const plan: TradingPlanInput = {
  version: 1,
  summary: "Observe and wait if no bounded opportunity exists",
  marketScope: ["gold"],
  monitoring: { watchIds: [], reevaluationAt: [] },
  executionApproach: "No fixed methodology; no forced trading",
  riskProposal: draft,
  evidenceRefs: [],
  chartRefs: [],
};
const limits: AccountRiskGuardrails = {
  version: 1,
  accountId: "account",
  mode: "SIMULATION",
  maxReservedRisk: "100",
  maxExposure: "100000",
  maxPendingExposure: "100000",
  maxActiveMandates: 2,
  maxDrawdown: null,
  maxMarginUsagePercent: "50",
  autonomousEnabled: true,
  frozen: false,
  revision: 1,
};
const jobs = {
  enqueue: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
};

async function killAfterPersisted(script: string, fixture: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH, MISSION_TEST_DATABASE_URL: url, ...fixture },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture persistence timed out")), 15000);
      child.stdout.on("data", (data: Buffer) => {
        if (data.toString().includes("PERSISTED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Fixture child failed"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Fixture exited before persistence"));
      });
    });
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (child.kill("SIGKILL")) await exited;
    }
  }
}

suite("owner-only durable trading goals/plans/mandates", () => {
  let db: ReturnType<typeof createDb>;
  let missions: TradingMissions;
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE simulation_market_receipts, simulation_market_cursors, simulation_executions, simulation_books, trade_previews, trade_proposals, trading_mission_wakes, trading_risk_reservations, trading_mandates, trading_plans, trading_goals, account_risk_guardrails, financial_journal, external_effects, trading_connections, organization, deployment_settings CASCADE`;
  beforeAll(() => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("Dedicated fixture _test database required");
    db = createDb(url);
    missions = new TradingMissions(db.prisma, () => now);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await reset();
    await db.prisma.deploymentSettings.create({
      data: {
        id: "default",
        singleOwnerEnforced: true,
        ownerUserId: owner,
        ownerSpaceId: "space",
        ownerBootstrapCompleted: true,
      },
    });
    await db.prisma.organization.create({
      data: { id: "org", slug: "fixture", name: "Fixture", createdAt: now },
    });
    await db.prisma.space.create({ data: { id: "space", organizationId: "org", name: "Fixture" } });
    await db.prisma.bot.create({
      data: {
        id: "main",
        spaceId: "space",
        userId: owner,
        name: "Fixture",
        color: "blue",
        spawnKey: "trading:main:v1",
      },
    });
    await db.prisma.thread.create({
      data: { id: "thread", botId: "main", userId: owner, spaceId: "space" },
    });
    await db.prisma.task.create({
      data: {
        id: "task",
        botId: "main",
        userId: owner,
        spaceId: "space",
        threadId: "thread",
        prompt: "Fixture",
        status: "running",
      },
    });
    await db.prisma.run.create({
      data: {
        id: "claimed",
        botId: "main",
        userId: owner,
        spaceId: "space",
        threadId: "thread",
        taskId: "task",
        status: "running",
        trigger: "message",
        leaseOwner: "worker-a",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    await db.prisma.tradingConnection.create({
      data: {
        id: "account",
        ownerUserId: owner,
        label: "Fixture",
        providerAccountId: "fixture-remote",
        ciphertext: "unused-fixture-reference",
      },
    });
    await db.prisma.brokerInstrument.create({
      data: {
        id: "gold",
        accountId: "account",
        brokerSymbol: "GOLD.a",
        displayName: "Gold",
        verifiedAt: now,
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
  async function proposed(riskProposal = draft) {
    const created = TradingGoalViewSchema.parse(
      await missions.command(actor, { operation: "goal_create", goal }, "request"),
    );
    const createdPlan = TradingPlanViewSchema.parse(
      await missions.command(actor, {
        operation: "plan_create",
        goalId: created.id,
        expectedVersion: 0,
        plan: { ...plan, riskProposal },
      }),
    );
    const mandate = TradingMandateViewSchema.parse(
      await missions.command(actor, { operation: "mandate_propose", planId: createdPlan.id }),
    );
    return { created, createdPlan, mandate };
  }
  async function activated(riskProposal = draft) {
    const rows = await proposed(riskProposal);
    await missions.setAccountGuardrails(owner, limits);
    const active = await missions.resolveMandate(owner, {
      id: rows.mandate.id,
      expectedRevision: 1,
      fingerprint: rows.mandate.fingerprint,
      approve: true,
    });
    return { ...rows, active };
  }
  describe("immutable financial preparation and trusted preview", () => {
    const action: FinancialAction = {
      version: 1,
      mode: "SIMULATION",
      provider: "metaapi",
      accountId: "account",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
      operation: "OPEN",
      side: "BUY",
      orderType: "MARKET",
      volume: "0.01",
      price: null,
      stopLimitPrice: null,
      expiresAt: null,
      fillingMode: null,
      stopLoss: "2695",
      takeProfit: "2710",
    };
    const facts: FinancialRiskFacts = {
      version: 1,
      accountId: "account",
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
        accountId: "account",
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
      orderTypes: ["MARKET", "LIMIT", "STOP"],
      partialClose: true,
      proposedMargin: "30",
      openPositions: [],
      pendingOrders: [],
    };
    async function prepared(
      overrideAction = action,
      preflight: () => Promise<FinancialRiskFacts> = vi.fn(async () => facts),
      riskProposal = draft,
    ) {
      const { active, createdPlan } = await activated(riskProposal);
      // Trusted observer fixture, not an agent tool; initial accounting is known empty here.
      await db.prisma.tradingMandate.update({
        where: { id: active.id },
        data: { observedAt: now },
      });
      const service = new TradeProposals(db.prisma, () => now, preflight);
      const command = {
        operation: "create",
        mandateId: active.id,
        planId: createdPlan.id,
        action: overrideAction,
        rationaleSummary: "A bounded opportunity, not a promised return",
        evidenceRefs: [],
        chartRefs: [],
      };
      const proposal = TradeProposalViewSchema.parse(
        await service.command(actor, command, "prepare"),
      );
      return { service, proposal, active, createdPlan, command, preflight };
    }
    async function financialPrepared(
      preflight?: () => Promise<FinancialRiskFacts>,
      overrideAction = action,
      riskProposal = draft,
    ) {
      const rows = await prepared(overrideAction, preflight, riskProposal);
      const previewed = TradeProposalViewSchema.parse(
        await rows.service.command(actor, {
          operation: "preview",
          proposalId: rows.proposal.id,
          expectedRevision: 1,
        }),
      );
      const effects = new FinancialEffects(db.prisma, () => now);
      const effect = await effects.prepare(
        actor,
        rows.proposal.id,
        previewed.preview?.id ?? "missing",
      );
      const reviewContext = {
        operationId: "fixture-review",
        traceId: "fixture",
        spaceId: "space",
        userId: owner,
        botId: "main",
        runId: "claimed",
        signal: new AbortController().signal,
      };
      return { ...rows, previewed, effects, effect, reviewContext };
    }
    async function simulatedPrepared(overrideAction = action, riskProposal = draft) {
      const simulator = new SimulationBroker(db.prisma, () => now);
      const rows = await financialPrepared(
        () => simulator.preflight(actor, facts),
        overrideAction,
        riskProposal,
      );
      const simulatedFacts = await simulator.preflight(actor, facts);
      await rows.effects.review(
        actor,
        rows.effect.id,
        new ScriptedAutoReviewProvider(),
        rows.reviewContext,
      );
      return { ...rows, simulator, simulatedFacts };
    }
    async function executionReady() {
      const simulator = new SimulationBroker(db.prisma, () => now);
      const rows = await financialPrepared(() => simulator.preflight(actor, facts));
      const execution = new FinancialExecution(
        db.prisma,
        () => now,
        (current) => simulator.preflight(current, facts),
      );
      return {
        ...rows,
        execution,
        command: {
          proposalId: rows.proposal.id,
          previewId: rows.previewed.preview?.id ?? "missing",
        },
      };
    }
    const managementScope: typeof draft = {
      ...draft,
      allowedOperations: [
        "OPEN",
        "MODIFY_PROTECTION",
        "CLOSE_POSITION",
        "MODIFY_ORDER",
        "CANCEL_ORDER",
      ],
    };
    async function acceptedExposure(overrideAction = action, scope = managementScope) {
      const rows = await simulatedPrepared(overrideAction, scope);
      await rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts);
      const outcome = await rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts);
      await rows.effects.settle(actor, rows.effect.id, outcome);
      return rows;
    }
    async function managementProposal(
      rows: Awaited<ReturnType<typeof simulatedPrepared>>,
      managedAction: FinancialAction,
      brokerFacts = facts,
    ) {
      const preflight = () => rows.simulator.preflight(actor, brokerFacts);
      const service = new TradeProposals(db.prisma, () => now, preflight);
      const proposal = TradeProposalViewSchema.parse(
        await service.command(
          actor,
          {
            operation: "create",
            mandateId: rows.active.id,
            planId: rows.createdPlan.id,
            action: managedAction,
            rationaleSummary: "Manage only the exact attributed exposure",
            evidenceRefs: [],
            chartRefs: [],
          },
          JSON.stringify(managedAction),
        ),
      );
      const previewed = TradeProposalViewSchema.parse(
        await service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
        }),
      );
      return {
        previewed,
        facts: await preflight(),
        execute: () =>
          new FinancialExecution(db.prisma, () => now, preflight).execute(
            actor,
            { proposalId: proposal.id, previewId: previewed.preview?.id ?? "missing" },
            new ScriptedAutoReviewProvider(),
            rows.reviewContext,
          ),
      };
    }
    const managementIdentity = {
      version: 1 as const,
      mode: "SIMULATION" as const,
      provider: "metaapi",
      accountId: "account",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
    };
    const marketQuote = (bid: string, ask: string, at = new Date(now.getTime() + 1000)) => ({
      ...facts.quote,
      bid,
      ask,
      sourceTime: at.toISOString(),
      receivedAt: at.toISOString(),
      revision: `quote-${at.getTime()}`,
    });
    async function observed(
      quote = marketQuote("2700", "2700.1"),
      at = new Date(quote.receivedAt),
    ) {
      const token = await claimBrokerSession(db.prisma, "account", "observer", at);
      if (!token) throw new Error("Fixture broker observer lease required");
      await withBrokerSessionFence(
        db.prisma,
        token,
        (tx) => observeSimulationAccount(tx, "account", [quote], at),
        at,
      );
      return token;
    }
    it("observes pending fills, protection and immutable receipts without per-quote agent turns", async () => {
      const rows = await acceptedExposure({
        ...action,
        orderType: "LIMIT",
        price: "2699",
        expiresAt: "2026-10-09T12:00:00Z",
      });
      const runCount = await db.prisma.run.count();
      const neutral = marketQuote("2700", "2700.1");
      await observed(neutral);
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(0);
      expect(await db.prisma.run.count()).toBe(runCount);
      await observed(marketQuote("2698", "2698.1", new Date(now.getTime() + 2000)));
      const book = SimulationBookStateSchema.parse(
        (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
          .state,
      );
      expect(book.positions[0]).toMatchObject({ entry: "2698.1", originEffectId: rows.effect.id });
      expect(book.orders).toEqual([]);
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).kind,
      ).toBe("POSITION");
      const closing = marketQuote("2712", "2712.1", new Date(now.getTime() + 3000));
      await observed(closing);
      await observed(closing);
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(2);
      expect(await db.prisma.tradingMissionWake.count({ where: { kind: "ACCOUNT_EVENT" } })).toBe(
        2,
      );
      expect(await db.prisma.run.count()).toBe(runCount);
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).status,
      ).toBe("RELEASED");
      const receipt = await db.prisma.simulationMarketReceipt.findFirstOrThrow();
      await expect(
        db.prisma.simulationMarketReceipt.update({
          where: { id: receipt.id },
          data: { type: "STOP_LOSS" },
        }),
      ).rejects.toThrow("immutable");
      await expect(
        db.prisma.simulationMarketReceipt.delete({ where: { id: receipt.id } }),
      ).rejects.toThrow("immutable");
    });
    async function streamFixture() {
      let listener: ((event: BrokerEvent) => void) | undefined;
      let clock = now;
      const unavailable = async () => {
        throw new Error("Unexpected provider operation in deterministic stream fixture");
      };
      const session: BrokerReadSession = {
        accountId: "account",
        account: unavailable,
        positions: unavailable,
        orders: unavailable,
        symbols: unavailable,
        specification: unavailable,
        quote: unavailable,
        candles: unavailable,
        preflight: vi.fn(async () => facts),
        capabilities: async () =>
          TradingCapabilitiesSchema.parse({
            version: 1,
            provider: "metaapi",
            accountId: "account",
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
            operations: [],
            orderTypes: [],
            partialClose: false,
            protectiveStops: false,
            nativeOco: false,
            clientReferences: false,
            verifiedAt: now.toISOString(),
            revision: "fixture-read-only",
          }),
        subscribe: vi.fn(async (_symbols, callback) => {
          listener = callback;
          return async () => {};
        }),
        close: vi.fn(async () => {}),
      };
      const provider: BrokerProvider = { id: "metaapi", connect: vi.fn(async () => session) };
      const secrets = new EncryptedSecretStore("fixture-only-encryption-key-long-enough");
      await secrets.start();
      const supervisor = new BrokerConnectionSupervisor(
        db.prisma,
        secrets,
        provider,
        undefined,
        () => clock,
        jobs,
      );
      return {
        supervisor,
        session,
        advance: (at: Date) => {
          clock = at;
        },
        emit: (event: BrokerEvent) => listener?.(event),
        close: async () => {
          await supervisor.close();
          await secrets.close();
        },
      };
    }
    it("keeps a transient fill and stop before visual coalescing without a connected UI", async () => {
      await acceptedExposure({
        ...action,
        orderType: "LIMIT",
        price: "2699",
        expiresAt: "2026-10-09T12:00:00Z",
      });
      const stream = await streamFixture();
      const { supervisor, session } = stream;
      try {
        await supervisor.tick();
        await supervisor.drain();
        expect(session.subscribe).toHaveBeenLastCalledWith(
          [{ instrumentId: "gold", symbol: "GOLD.a" }],
          expect.any(Function),
        );
        stream.advance(new Date(now.getTime() + 3000));
        stream.emit({
          type: "quote",
          quote: marketQuote("2698", "2698.1", new Date(now.getTime() + 1000)),
        });
        stream.emit({
          type: "quote",
          quote: marketQuote("2690", "2690.1", new Date(now.getTime() + 2000)),
        });
        stream.emit({
          type: "quote",
          quote: marketQuote("2700", "2700.1", new Date(now.getTime() + 3000)),
        });
        await supervisor.tick();
        await supervisor.drain();
        const book = SimulationBookStateSchema.parse(
          (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
            .state,
        );
        expect(book.positions).toEqual([]);
        expect(book.orders).toEqual([]);
        expect(book.balance).toBe("9991.9");
        expect(
          await db.prisma.simulationMarketReceipt.count({ where: { type: "ORDER_FILLED" } }),
        ).toBe(1);
        expect(
          await db.prisma.simulationMarketReceipt.count({ where: { type: "STOP_LOSS" } }),
        ).toBe(1);
        expect(await db.prisma.run.count()).toBe(1);
      } finally {
        await stream.close();
      }
    });
    it("captures protection immediately after admission before the periodic exposure cache refresh", async () => {
      const rows = await simulatedPrepared();
      const stream = await streamFixture();
      try {
        await db.prisma.brokerReadRequest.create({
          data: {
            accountId: "account",
            ownerUserId: owner,
            operation: "preflight",
            parameters: {
              operation: "preflight",
              accountId: "account",
              instrumentId: "gold",
              action,
            },
            deadline: new Date(now.getTime() + 15000),
          },
        });
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(stream.session.preflight).toHaveBeenCalledWith(action);
        expect(stream.session.subscribe).toHaveBeenLastCalledWith(
          [{ instrumentId: "gold", symbol: "GOLD.a" }],
          expect.any(Function),
        );
        await rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts);
        await rows.effects.settle(
          actor,
          rows.effect.id,
          await rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts),
        );
        stream.advance(new Date(now.getTime() + 2000));
        stream.emit({
          type: "quote",
          quote: marketQuote("2690", "2690.1", new Date(now.getTime() + 1000)),
        });
        stream.emit({
          type: "quote",
          quote: marketQuote("2700", "2700.1", new Date(now.getTime() + 2000)),
        });
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(
          await db.prisma.simulationMarketReceipt.count({ where: { type: "STOP_LOSS" } }),
        ).toBe(1);
        expect(
          SimulationBookStateSchema.parse(
            (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
              .state,
          ).positions,
        ).toEqual([]);
      } finally {
        await stream.close();
      }
    });
    async function chartDemands(count: number) {
      const instruments = Array.from({ length: count }, (_, index) => ({
        id: `chart-${index.toString().padStart(3, "0")}`,
        accountId: "account",
        brokerSymbol: `CHART${index}`,
        displayName: `Fixture ${index}`,
      }));
      await db.prisma.brokerInstrument.createMany({ data: instruments });
      await db.prisma.brokerMarketSubscription.createMany({
        data: instruments.map((instrument) => ({
          accountId: "account",
          ownerUserId: owner,
          instrumentId: instrument.id,
          expiresAt: new Date(now.getTime() + 60000),
        })),
      });
      return instruments;
    }
    it("keeps financial stop ticks when unrelated chart quotes fill the visual batch", async () => {
      await acceptedExposure();
      const instruments = await chartDemands(255);
      const stream = await streamFixture();
      try {
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(vi.mocked(stream.session.subscribe).mock.calls.at(-1)?.[0]).toHaveLength(256);
        stream.advance(new Date(now.getTime() + 3000));
        for (const [index, instrument] of instruments.entries())
          stream.emit({
            type: "quote",
            quote: {
              ...marketQuote("100", "100.1", new Date(now.getTime() + index + 1)),
              instrumentId: instrument.id,
              brokerSymbol: instrument.brokerSymbol,
            },
          });
        for (const [index, bid] of ["2700", "2690", "2700"].entries())
          stream.emit({
            type: "quote",
            quote: marketQuote(bid, `${bid}.1`, new Date(now.getTime() + (index + 1) * 1000)),
          });
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(
          await db.prisma.simulationMarketReceipt.count({ where: { type: "STOP_LOSS" } }),
        ).toBe(1);
        expect(
          await db.prisma.financialJournal.count({
            where: { event: "SIMULATION_OBSERVER_BACKPRESSURE" },
          }),
        ).toBe(0);
      } finally {
        await stream.close();
      }
    });
    it("promotes a financial symbol ahead of an unchanged oversized chart demand set", async () => {
      await chartDemands(300);
      await db.prisma.brokerMarketSubscription.create({
        data: {
          accountId: "account",
          ownerUserId: owner,
          instrumentId: "gold",
          expiresAt: new Date(now.getTime() + 60000),
        },
      });
      const stream = await streamFixture();
      try {
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(
          vi
            .mocked(stream.session.subscribe)
            .mock.calls.at(-1)?.[0]
            .some((item) => item.instrumentId === "gold"),
        ).toBe(false);
        const beforePromotion = vi.mocked(stream.session.subscribe).mock.calls.length;
        await acceptedExposure();
        stream.advance(new Date(now.getTime() + 1000));
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        const selected = vi.mocked(stream.session.subscribe).mock.calls.at(-1)?.[0];
        expect(selected).toHaveLength(256);
        expect(selected?.[0]).toEqual({ instrumentId: "gold", symbol: "GOLD.a" });
        expect(stream.session.subscribe).toHaveBeenCalledTimes(beforePromotion + 1);
      } finally {
        await stream.close();
      }
    });
    it.each([
      { name: "target", price: "3001.1", scope: managementScope, status: "TARGET_REACHED" },
      {
        name: "aggregate loss budget",
        price: "2696",
        scope: { ...managementScope, maxMissionLoss: "10" },
        status: "RISK_STOPPED",
      },
    ])(
      "retains a transient $name crossing without an individual stop or target exit",
      async ({ price, scope, status }) => {
        const rows = await acceptedExposure({ ...action, takeProfit: null }, scope);
        const stream = await streamFixture();
        try {
          await stream.supervisor.tick();
          await stream.supervisor.drain();
          stream.advance(new Date(now.getTime() + 3000));
          stream.emit({
            type: "quote",
            quote: marketQuote(price, price, new Date(now.getTime() + 1000)),
          });
          stream.emit({
            type: "quote",
            quote: marketQuote("2700", "2700.1", new Date(now.getTime() + 2000)),
          });
          await stream.supervisor.tick();
          await stream.supervisor.drain();
          expect(
            (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
              .status,
          ).toBe(status);
          expect(await db.prisma.simulationMarketReceipt.count()).toBe(0);
          expect(
            await db.prisma.tradingMissionWake.count({
              where: { mandateId: rows.active.id, kind: "ACCOUNT_EVENT" },
            }),
          ).toBe(1);
        } finally {
          await stream.close();
        }
      },
    );
    it("fails safely and journals one attention wake when financial tick buffering overflows", async () => {
      const rows = await acceptedExposure();
      const stream = await streamFixture();
      try {
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        stream.advance(new Date(now.getTime() + 2000));
        for (let index = 0; index < 300; index++)
          stream.emit({
            type: "quote",
            quote: marketQuote("2700", "2700.1", new Date(now.getTime() + 1000 + index)),
          });
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(
          (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
            .status,
        ).toBe("NEEDS_ATTENTION");
        expect(
          await db.prisma.financialJournal.count({
            where: { event: "SIMULATION_OBSERVER_BACKPRESSURE" },
          }),
        ).toBe(1);
        expect(await db.prisma.simulationMarketReceipt.count()).toBe(0);
        expect(await db.prisma.run.count()).toBe(1);
      } finally {
        await stream.close();
      }
    });
    it("pauses on provider disconnect without cancelling already-authorized protective observation", async () => {
      const rows = await acceptedExposure();
      const stream = await streamFixture();
      try {
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        stream.advance(new Date(now.getTime() + 1000));
        stream.emit({
          type: "connection_changed",
          accountId: "account",
          connected: false,
          receivedAt: new Date(now.getTime() + 1000).toISOString(),
        });
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(
          (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
            .status,
        ).toBe("NEEDS_ATTENTION");
        stream.advance(new Date(now.getTime() + 2000));
        stream.emit({
          type: "quote",
          quote: marketQuote("2690", "2690.1", new Date(now.getTime() + 2000)),
        });
        await stream.supervisor.tick();
        await stream.supervisor.drain();
        expect(
          await db.prisma.simulationMarketReceipt.count({ where: { type: "STOP_LOSS" } }),
        ).toBe(1);
        expect(
          (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
            .status,
        ).toBe("NEEDS_ATTENTION");
      } finally {
        await stream.close();
      }
    });
    it("retains adverse-gap risk and freezes account capacity instead of pretending pending fills have no risk", async () => {
      const rows = await acceptedExposure(
        {
          ...action,
          orderType: "STOP",
          price: "2701",
          takeProfit: null,
          expiresAt: "2026-10-09T12:00:00Z",
        },
        { ...managementScope, allowedOrderTypes: ["MARKET", "LIMIT", "STOP"] },
      );
      await missions.setAccountGuardrails(owner, { ...limits, maxReservedRisk: "15" });
      await observed(marketQuote("2715", "2715.1"));
      const reservation = await db.prisma.tradingRiskReservation.findUniqueOrThrow({
        where: { effectId: rows.effect.id },
      });
      expect(reservation.kind).toBe("POSITION");
      expect(reservation.risk.toFixed()).toBe("23.45");
      expect(reservation.status).toBe("COMMITTED");
      const guard = await db.prisma.accountRiskGuardrail.findUniqueOrThrow({
        where: { accountId_mode: { accountId: "account", mode: "SIMULATION" } },
      });
      expect(guard.frozen).toBe(true);
      expect(
        (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
          .status,
      ).toBe("PAUSED");
      const book = SimulationBookStateSchema.parse(
        (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
          .state,
      );
      expect(book.positions[0]?.margin).toBe(reservation.margin.toFixed());
    });
    it("expires through the existing deadline job after downtime and ignores replaced deadlines", async () => {
      const rows = await acceptedExposure({
        ...action,
        orderType: "LIMIT",
        price: "2699",
        expiresAt: "2026-10-09T12:00:00Z",
      });
      await enqueueSimulationExpiries(db.prisma, jobs, "account", now);
      expect(jobs.enqueue).toHaveBeenCalledWith({
        name: "trading.simulation-expire",
        payload: { accountId: "account", scheduledFor: "2026-10-09T12:00:00.000Z" },
        availableAt: new Date("2026-10-09T12:00:00Z"),
        replaceKey: "trading.simulation-expire:account",
      });
      await expireSimulationAccount(
        db.prisma,
        "account",
        "2026-10-09T11:00:00Z",
        new Date("2026-10-09T13:00:00Z"),
      );
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(0);
      await expireSimulationAccount(
        db.prisma,
        "account",
        "2026-10-09T12:00:00Z",
        new Date("2026-10-09T13:00:00Z"),
      );
      await expireSimulationAccount(
        db.prisma,
        "account",
        "2026-10-09T12:00:00Z",
        new Date("2026-10-09T13:00:00Z"),
      );
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(1);
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).status,
      ).toBe("RELEASED");
      expect(
        (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
          .nextExpiryAt,
      ).toBeNull();
    });
    it("ignores stale, out-of-order and wrong-symbol quotes without rewinding observed state", async () => {
      await acceptedExposure();
      await observed(marketQuote("2701", "2701.1", new Date(now.getTime() + 2000)));
      await observed(
        marketQuote("2690", "2690.1", new Date(now.getTime() + 1000)),
        new Date(now.getTime() + 2000),
      );
      await observed({
        ...marketQuote("2690", "2690.1", new Date(now.getTime() + 3000)),
        brokerSymbol: "foreign",
      });
      await observed({
        ...marketQuote("2690", "2690.1", new Date(now.getTime() + 3000)),
        sourceTime: new Date(now.getTime() - 20000).toISOString(),
      });
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(0);
      expect(
        SimulationBookStateSchema.parse(
          (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
            .state,
        ).positions,
      ).toHaveLength(1);
    });
    it("rejects a stale broker session after takeover even when it reads the current book", async () => {
      await acceptedExposure();
      const previous = await observed();
      const later = new Date(now.getTime() + 32000);
      const current = await claimBrokerSession(db.prisma, "account", "replacement", later);
      expect(current?.generation).toBe(previous.generation + 1);
      await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } });
      await expect(
        withBrokerSessionFence(
          db.prisma,
          previous,
          (tx) =>
            observeSimulationAccount(tx, "account", [marketQuote("2690", "2690.1", later)], later),
          later,
        ),
      ).rejects.toThrow("stale or revoked");
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(0);
    });
    it("rolls back book, ledger, P&L and logical wake when an observation receipt cannot commit", async () => {
      const rows = await acceptedExposure();
      const before = await db.prisma.simulationBook.findUniqueOrThrow({
        where: { accountId: "account" },
      });
      await db.prisma
        .$executeRaw`ALTER TABLE simulation_market_receipts ADD CONSTRAINT fixture_test_reject_observation CHECK (false) NOT VALID`;
      try {
        await expect(observed(marketQuote("2690", "2690.1"))).rejects.toThrow();
        expect(
          await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }),
        ).toEqual(before);
        expect(
          (
            await db.prisma.tradingRiskReservation.findUniqueOrThrow({
              where: { effectId: rows.effect.id },
            })
          ).status,
        ).toBe("COMMITTED");
        expect(await db.prisma.tradingMissionWake.count({ where: { kind: "ACCOUNT_EVENT" } })).toBe(
          0,
        );
      } finally {
        await db.prisma
          .$executeRaw`ALTER TABLE simulation_market_receipts DROP CONSTRAINT fixture_test_reject_observation`;
      }
    });
    it.each([
      ["3001", "3001.1", "TARGET_REACHED"],
      ["2500", "2500.1", "RISK_STOPPED"],
    ])(
      "stops new risk on observed target/loss and preserves terminal notification delivery",
      async (bid, ask, status) => {
        const rows = await acceptedExposure();
        await observed(marketQuote(bid, ask));
        expect(
          (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
            .status,
        ).toBe(status);
        const wake = await db.prisma.tradingMissionWake.findFirstOrThrow({
          where: { mandateId: rows.active.id, kind: "ACCOUNT_EVENT" },
        });
        await wakeTradingMission(
          db.prisma,
          jobs,
          wake.id,
          wake.dueAt.toISOString(),
          new Date(now.getTime() + 1000),
        );
        await wakeTradingMission(
          db.prisma,
          jobs,
          wake.id,
          wake.dueAt.toISOString(),
          new Date(now.getTime() + 1000),
        );
        expect(
          (await db.prisma.tradingMissionWake.findUniqueOrThrow({ where: { id: wake.id } })).status,
        ).toBe("QUEUED");
        expect(await db.prisma.run.count({ where: { clientNonce: wake.wakeKey } })).toBe(1);
      },
    );
    it("recovers committed observation after actual process death without another close or balance change", async () => {
      const rows = await acceptedExposure();
      const quote = marketQuote("2690", "2690.1");
      await killAfterPersisted(
        `import {createDb,claimBrokerSession,withBrokerSessionFence} from '@rakazo/db'; import {observeSimulationAccount} from './src/simulation-market.ts';
const db=createDb(process.env.MISSION_TEST_DATABASE_URL); const quote=JSON.parse(process.env.FIXTURE_QUOTE); const now=new Date(quote.receivedAt); const token=await claimBrokerSession(db.prisma,'account','observer',now); await withBrokerSessionFence(db.prisma,token,tx=>observeSimulationAccount(tx,'account',[quote],now),now); process.stdout.write('PERSISTED'); await new Promise(()=>{});`,
        { FIXTURE_QUOTE: JSON.stringify(quote) },
      );
      const before = await db.prisma.simulationBook.findUniqueOrThrow({
        where: { accountId: "account" },
      });
      await observed(quote);
      expect(
        await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }),
      ).toEqual(before);
      expect(await db.prisma.simulationMarketReceipt.count()).toBe(1);
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).status,
      ).toBe("RELEASED");
    });
    it("tightens protection and partially/full closes without duplicating exposure reservations", async () => {
      const rows = await acceptedExposure({ ...action, volume: "0.02" });
      const positionId = `sim_${rows.effect.id}`;
      const tighten = await managementProposal(rows, {
        ...managementIdentity,
        operation: "MODIFY_PROTECTION",
        positionId,
        stopLoss: "2699",
        takeProfit: "2710",
      });
      expect(await tighten.execute()).toMatchObject({ status: "SUCCEEDED" });
      let reservation = await db.prisma.tradingRiskReservation.findUniqueOrThrow({
        where: { effectId: rows.effect.id },
      });
      expect(reservation.risk.toFixed()).toBe("3.2");
      const partial = await managementProposal(rows, {
        ...managementIdentity,
        operation: "CLOSE_POSITION",
        positionId,
        volume: "0.01",
      });
      expect(await partial.execute()).toMatchObject({ status: "SUCCEEDED" });
      let book = SimulationBookStateSchema.parse(
        (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
          .state,
      );
      expect(book.positions).toMatchObject([
        { id: positionId, volume: "0.01", margin: "15", stopLoss: "2699" },
      ]);
      reservation = await db.prisma.tradingRiskReservation.findUniqueOrThrow({
        where: { effectId: rows.effect.id },
      });
      expect(reservation.risk.toFixed()).toBe("2.1");
      expect(
        await db.prisma.tradingRiskReservation.findMany({ where: { status: "COMMITTED" } }),
      ).toHaveLength(1);
      const close = await managementProposal(rows, {
        ...managementIdentity,
        operation: "CLOSE_POSITION",
        positionId,
        volume: null,
      });
      const result = await close.execute();
      expect(result.status).toBe("SUCCEEDED");
      expect(await close.execute()).toEqual(result);
      book = SimulationBookStateSchema.parse(
        (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
          .state,
      );
      expect(book.positions).toEqual([]);
      expect(book.balance).toBe("9999.8");
      expect(book.performance).toMatchObject([{ mandateId: rows.active.id, realized: "-0.2" }]);
      expect(
        await db.prisma.tradingRiskReservation.count({
          where: { status: { in: ["RESERVED", "COMMITTED", "UNCERTAIN"] } },
        }),
      ).toBe(0);
      expect(await db.prisma.simulationExecution.count()).toBe(4);
    });
    it("can protect a profitable position but cannot widen protection without explicit scope", async () => {
      const rows = await acceptedExposure();
      const positionId = `sim_${rows.effect.id}`;
      const profitable = {
        ...facts,
        quote: { ...facts.quote, bid: "2720", ask: "2720.1", revision: "profit" },
      };
      const protect = await managementProposal(
        rows,
        {
          ...managementIdentity,
          operation: "MODIFY_PROTECTION",
          positionId,
          stopLoss: "2710",
          takeProfit: "2730",
        },
        profitable,
      );
      expect(await protect.execute()).toMatchObject({ status: "SUCCEEDED" });
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).risk.toFixed(),
      ).toBe("1");
      const widen = await managementProposal(
        rows,
        {
          ...managementIdentity,
          operation: "MODIFY_PROTECTION",
          positionId,
          stopLoss: "2705",
          takeProfit: "2730",
        },
        profitable,
      );
      expect(widen.previewed.preview?.risk).toEqual({
        decision: "DENY",
        code: "STOP_WIDENING_NOT_AUTHORIZED",
      });
      await expect(widen.execute()).rejects.toThrow();
      expect(await db.prisma.simulationExecution.count()).toBe(2);
    });
    it("reserves explicitly authorized stop widening without exceeding mission risk", async () => {
      const rows = await acceptedExposure(action, {
        ...managementScope,
        riskIncreasePermissions: ["WIDEN_STOP"],
      });
      const change = await managementProposal(rows, {
        ...managementIdentity,
        operation: "MODIFY_PROTECTION",
        positionId: `sim_${rows.effect.id}`,
        stopLoss: "2693",
        takeProfit: "2710",
      });
      expect(change.previewed.preview?.risk).toMatchObject({
        decision: "ALLOW",
        incrementalRisk: "2",
        classification: "INCREASES_RISK",
      });
      expect(await change.execute()).toMatchObject({ status: "SUCCEEDED" });
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).risk.toFixed(),
      ).toBe("8.1");
      expect(await db.prisma.tradingRiskReservation.count({ where: { status: "COMMITTED" } })).toBe(
        1,
      );
    });
    it("updates and cancels an attributed pending order while retaining risk until acceptance", async () => {
      const rows = await acceptedExposure({
        ...action,
        orderType: "LIMIT",
        price: "2699",
        stopLoss: "2695",
        expiresAt: "2026-10-09T20:00:00Z",
      });
      const orderId = `sim_${rows.effect.id}`;
      const update = await managementProposal(rows, {
        ...managementIdentity,
        operation: "MODIFY_ORDER",
        orderId,
        price: "2698",
        volume: "0.01",
        stopLoss: "2696",
        takeProfit: "2710",
        expiresAt: "2026-10-09T18:00:00Z",
        stopLimitPrice: null,
      });
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).risk.toFixed(),
      ).toBe("5");
      expect(await update.execute()).toMatchObject({ status: "SUCCEEDED" });
      const updated = await db.prisma.tradingRiskReservation.findUniqueOrThrow({
        where: { effectId: rows.effect.id },
      });
      expect(updated.risk.toFixed()).toBe("3");
      expect(updated.exposure.toFixed()).toBe("2698");
      const cancel = await managementProposal(rows, {
        ...managementIdentity,
        operation: "CANCEL_ORDER",
        orderId,
      });
      expect(await cancel.execute()).toMatchObject({ status: "SUCCEEDED" });
      expect(
        SimulationBookStateSchema.parse(
          (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
            .state,
        ).orders,
      ).toEqual([]);
      expect(
        await db.prisma.tradingRiskReservation.count({
          where: { status: { in: ["COMMITTED", "RESERVED", "UNCERTAIN"] } },
        }),
      ).toBe(0);
    });
    it("counts the additional volume/risk/margin of an explicitly authorized pending-order increase", async () => {
      const rows = await acceptedExposure(
        {
          ...action,
          orderType: "LIMIT",
          price: "2699",
          stopLoss: "2695",
          expiresAt: "2026-10-09T20:00:00Z",
        },
        { ...managementScope, riskIncreasePermissions: ["INCREASE_PENDING_VOLUME"] },
      );
      const increase = await managementProposal(
        rows,
        {
          ...managementIdentity,
          operation: "MODIFY_ORDER",
          orderId: `sim_${rows.effect.id}`,
          price: "2699",
          volume: "0.02",
          stopLoss: "2695",
          takeProfit: "2710",
          expiresAt: "2026-10-09T18:00:00Z",
          stopLimitPrice: null,
        },
        { ...facts, proposedMargin: "60" },
      );
      expect(increase.previewed.preview?.risk).toMatchObject({
        decision: "ALLOW",
        incrementalRisk: "4",
        notional: "2699",
      });
      expect(await increase.execute()).toMatchObject({ status: "SUCCEEDED" });
      const reserved = await db.prisma.tradingRiskReservation.findUniqueOrThrow({
        where: { effectId: rows.effect.id },
      });
      expect(reserved.risk.toFixed()).toBe("9");
      expect(reserved.margin.toFixed()).toBe("60");
      expect(reserved.exposure.toFixed()).toBe("5398");
    });
    it("rejects concurrent stale management facts instead of overwriting the newer protection", async () => {
      const rows = await acceptedExposure();
      const first = await managementProposal(rows, {
        ...managementIdentity,
        operation: "MODIFY_PROTECTION",
        positionId: `sim_${rows.effect.id}`,
        stopLoss: "2698",
        takeProfit: "2710",
      });
      const second = await managementProposal(rows, {
        ...managementIdentity,
        operation: "MODIFY_PROTECTION",
        positionId: `sim_${rows.effect.id}`,
        stopLoss: "2699",
        takeProfit: "2710",
      });
      const prepared = await rows.effects.prepare(
        actor,
        second.previewed.id,
        second.previewed.preview?.id ?? "missing",
      );
      await rows.effects.review(
        actor,
        prepared.id,
        new ScriptedAutoReviewProvider(),
        rows.reviewContext,
      );
      expect(await first.execute()).toMatchObject({ status: "SUCCEEDED" });
      await expect(rows.effects.begin(actor, prepared.id, second.facts)).rejects.toThrow(
        "revision conflict",
      );
      expect(
        SimulationBookStateSchema.parse(
          (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
            .state,
        ).positions[0]?.stopLoss,
      ).toBe("2698");
    });
    it("does not partially close again after actual process death following management acceptance", async () => {
      const rows = await acceptedExposure({ ...action, volume: "0.02" });
      const partial = await managementProposal(rows, {
        ...managementIdentity,
        operation: "CLOSE_POSITION",
        positionId: `sim_${rows.effect.id}`,
        volume: "0.01",
      });
      const effect = await rows.effects.prepare(
        actor,
        partial.previewed.id,
        partial.previewed.preview?.id ?? "missing",
      );
      await rows.effects.review(
        actor,
        effect.id,
        new ScriptedAutoReviewProvider(),
        rows.reviewContext,
      );
      await killAfterPersisted(
        `import {createDb} from '@rakazo/db'; import {FinancialEffects} from './src/financial-effects.ts'; import {SimulationBroker} from './src/simulation-broker.ts';
        const db=createDb(process.env.MISSION_TEST_DATABASE_URL); const time=()=>new Date(process.env.FIXTURE_TIME);
        const actor=JSON.parse(process.env.FIXTURE_ACTOR); const facts=JSON.parse(process.env.FIXTURE_FACTS);
        await new FinancialEffects(db.prisma,time).begin(actor,process.env.FIXTURE_EFFECT,facts);
        await new SimulationBroker(db.prisma,time).execute(actor,process.env.FIXTURE_EFFECT,facts);
        console.log('PERSISTED'); setInterval(()=>{},1000);`,
        {
          FIXTURE_TIME: now.toISOString(),
          FIXTURE_ACTOR: JSON.stringify(actor),
          FIXTURE_EFFECT: effect.id,
          FIXTURE_FACTS: JSON.stringify(partial.facts),
        },
      );
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseFence: 2, leaseOwner: "worker-b" },
      });
      const current = {
        ...actor,
        execution: { runId: "claimed", holder: "worker-b", generation: 2 },
      };
      await rows.effects.recoverInterrupted();
      expect((await rows.effects.reconcileSimulation(current, effect.id)).status).toBe("completed");
      expect((await rows.effects.reconcileSimulation(current, effect.id)).status).toBe("completed");
      const book = SimulationBookStateSchema.parse(
        (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
          .state,
      );
      expect(book.positions).toMatchObject([{ volume: "0.01", margin: "15" }]);
      expect(book.balance).toBe("9999.9");
      expect(await db.prisma.simulationExecution.count()).toBe(2);
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).risk.toFixed(),
      ).toBe("6.1");
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: effect.id },
          })
        ).status,
      ).toBe("RELEASED");
    });
    it("rejects invalid remaining volume and unknown/unattributed target IDs without financial effects", async () => {
      const rows = await acceptedExposure();
      const invalid = await managementProposal(rows, {
        ...managementIdentity,
        operation: "CLOSE_POSITION",
        positionId: `sim_${rows.effect.id}`,
        volume: "0.01",
      });
      expect(invalid.previewed.preview?.risk).toEqual({
        decision: "DENY",
        code: "INVALID_PARTIAL_CLOSE",
      });
      await expect(invalid.execute()).rejects.toThrow();
      await expect(
        managementProposal(rows, {
          ...managementIdentity,
          operation: "CLOSE_POSITION",
          positionId: "unattributed-broker-position",
          volume: null,
        }),
      ).rejects.toThrow("attributed mandate");
      expect(await db.prisma.simulationExecution.count()).toBe(1);
      expect(await db.prisma.externalEffect.count()).toBe(1);
    });
    it("runs the full approved-mandate/review/risk/effect/simulation pipeline once", async () => {
      const rows = await executionReady();
      const result = await rows.execution.execute(
        actor,
        rows.command,
        new ScriptedAutoReviewProvider(),
        rows.reviewContext,
      );
      expect(result).toMatchObject({
        mode: "SIMULATION",
        status: "SUCCEEDED",
        providerReference: `sim_${rows.effect.id}`,
      });
      expect(
        await rows.execution.execute(
          actor,
          rows.command,
          new ScriptedAutoReviewProvider(),
          rows.reviewContext,
        ),
      ).toEqual(result);
      expect(await db.prisma.simulationExecution.count()).toBe(1);
      expect(await db.prisma.externalEffect.count()).toBe(1);
      expect(await db.prisma.tradingRiskReservation.count()).toBe(1);
    });
    it.each(["deny", "ask"] as const)(
      "never reserves or sends a simulated action when independent review returns %s",
      async (decision) => {
        const rows = await executionReady();
        const result = await rows.execution.execute(
          actor,
          rows.command,
          new ScriptedAutoReviewProvider({ decision, model: "fixture" }),
          rows.reviewContext,
        );
        expect(result.status).toBe(decision === "deny" ? "DENIED" : "APPROVAL_REQUIRED");
        expect(await db.prisma.simulationExecution.count()).toBe(0);
        expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
        if (result.status === "APPROVAL_REQUIRED")
          expect(result.ask).toMatchObject({
            kind: "ask",
            approvalEffectId: rows.effect.id,
            actions: [
              { id: "allow", label: "Approve once" },
              { id: "deny", label: "Deny" },
            ],
          });
      },
    );
    it("missing independent review escalates safely without activating an effect", async () => {
      const rows = await executionReady();
      expect(
        (await rows.execution.execute(actor, rows.command, undefined, rows.reviewContext)).status,
      ).toBe("APPROVAL_REQUIRED");
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: rows.effect.id } }))
          .reviewDecision,
      ).toBe("ask");
      expect(await db.prisma.simulationExecution.count()).toBe(0);
    });
    it("refreshes the exact preview after an owner approval wait and resumes without blanket authority", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const rows = await executionReady();
        const requested = await rows.execution.execute(
          actor,
          rows.command,
          undefined,
          rows.reviewContext,
        );
        if (requested.status !== "APPROVAL_REQUIRED") throw new Error("Expected owner escalation");
        await db.prisma.run.update({
          where: { id: "claimed" },
          data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
        });
        const message = await db.prisma.message.create({
          data: {
            seq: 0,
            threadId: "thread",
            runId: "claimed",
            botId: "main",
            role: "bot",
            blocks: [requested.ask],
          },
        });
        const later = new Date(now.getTime() + 60000);
        vi.setSystemTime(later);
        expect(
          await answerRunInput(db.prisma, {
            spaceId: "space",
            threadId: "thread",
            runId: "claimed",
            messageId: message.id,
            answeredByUserId: owner,
            answer: "allow",
          }),
        ).toBe(true);
        await db.prisma.run.update({
          where: { id: "claimed" },
          data: {
            status: "running",
            leaseOwner: "worker-b",
            leaseFence: 2,
            leaseExpiresAt: new Date(later.getTime() + 60000),
          },
        });
        const current = {
          ...actor,
          execution: { runId: "claimed", holder: "worker-b", generation: 2 },
        };
        const freshFacts = {
          ...facts,
          observedAt: later.toISOString(),
          specificationObservedAt: later.toISOString(),
          quote: {
            ...facts.quote,
            sourceTime: later.toISOString(),
            receivedAt: later.toISOString(),
          },
        };
        const simulator = new SimulationBroker(db.prisma, () => later);
        const proposal = TradeProposalViewSchema.parse(
          await new TradeProposals(
            db.prisma,
            () => later,
            () => simulator.preflight(current, freshFacts),
          ).command(current, {
            operation: "preview",
            proposalId: rows.proposal.id,
            expectedRevision: 2,
          }),
        );
        const result = await new FinancialExecution(
          db.prisma,
          () => later,
          () => simulator.preflight(current, freshFacts),
        ).execute(
          current,
          { proposalId: proposal.id, previewId: proposal.preview?.id ?? "missing" },
          undefined,
          rows.reviewContext,
        );
        expect(result.status).toBe("SUCCEEDED");
        expect(await db.prisma.simulationExecution.count()).toBe(1);
        expect(await db.prisma.actionApprovalRule.count()).toBe(0);
        expect(
          (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: rows.effect.id } }))
            .reviewDecision,
        ).toBe("ask");
      } finally {
        vi.useRealTimers();
      }
    });
    it("executes a reserved simulation once, preserves immutable receipts and attributes fresh virtual P&L", async () => {
      const rows = await simulatedPrepared();
      expect(rows.simulatedFacts.simulationRevision).toBe(1);
      await expect(
        rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts),
      ).rejects.toThrow("STARTED");
      await rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts);
      const outcome = await rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts);
      expect(outcome).toMatchObject({
        status: "SUCCEEDED",
        providerReference: `sim_${rows.effect.id}`,
      });
      expect(await rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts)).toEqual(
        outcome,
      );
      expect(await db.prisma.simulationExecution.count()).toBe(1);
      await rows.effects.settle(actor, rows.effect.id, outcome);
      const fresh = await rows.simulator.preflight(actor, facts);
      expect(fresh).toMatchObject({
        simulationRevision: 2,
        margin: "30",
        equity: "9999.9",
        openPositions: [{ id: `sim_${rows.effect.id}`, volume: "0.01" }],
      });
      expect(
        (
          await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } })
        ).missionPnl.toFixed(),
      ).toBe("-0.1");
      expect(await rows.simulator.receipt(owner, rows.effect.id)).toEqual(outcome);
      await expect(rows.simulator.receipt("peer", rows.effect.id)).rejects.toThrow();
      await expect(
        db.prisma.simulationExecution.update({
          where: { effectId: rows.effect.id },
          data: { outcome: {} },
        }),
      ).rejects.toThrow("immutable");
      const book = await db.prisma.simulationBook.findUniqueOrThrow({
        where: { accountId: "account" },
      });
      await expect(
        db.prisma.simulationBook.update({
          where: { accountId: "account" },
          data: {
            state: { ...SimulationBookStateSchema.parse(book.state), mode: "LIVE" },
            revision: { increment: 1 },
          },
        }),
      ).rejects.toThrow();
    });
    it("rejects stale simulation facts and stale workers before any virtual provider mutation", async () => {
      const rows = await simulatedPrepared();
      const book = await db.prisma.simulationBook.findUniqueOrThrow({
        where: { accountId: "account" },
      });
      await db.prisma.simulationBook.update({
        where: { accountId: "account" },
        data: { state: SimulationBookStateSchema.parse(book.state), revision: { increment: 1 } },
      });
      await expect(rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts)).rejects.toThrow(
        "revision conflict",
      );
      const current = await rows.simulator.preflight(actor, facts);
      await rows.effects.begin(actor, rows.effect.id, current);
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseFence: 2, leaseOwner: "worker-b" },
      });
      await expect(rows.simulator.execute(actor, rows.effect.id, current)).rejects.toThrow();
      expect(await db.prisma.simulationExecution.count()).toBe(0);
    });
    it("rolls back a simulated fill if provider acceptance cannot be recorded", async () => {
      const rows = await simulatedPrepared();
      await rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts);
      await db.prisma
        .$executeRaw`ALTER TABLE simulation_executions ADD CONSTRAINT fixture_test_reject_simulation CHECK (false) NOT VALID`;
      try {
        await expect(
          rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts),
        ).rejects.toThrow();
        expect(
          (await db.prisma.simulationBook.findUniqueOrThrow({ where: { accountId: "account" } }))
            .revision,
        ).toBe(1);
        expect(await db.prisma.simulationExecution.count()).toBe(0);
      } finally {
        await db.prisma
          .$executeRaw`ALTER TABLE simulation_executions DROP CONSTRAINT fixture_test_reject_simulation`;
      }
    });
    it("reconciles actual process death after simulation acceptance without a duplicate fill", async () => {
      const rows = await simulatedPrepared();
      await killAfterPersisted(
        `import {createDb} from '@rakazo/db'; import {FinancialEffects} from './src/financial-effects.ts'; import {SimulationBroker} from './src/simulation-broker.ts';
        const db=createDb(process.env.MISSION_TEST_DATABASE_URL);
        const time=()=>new Date(process.env.FIXTURE_TIME); const actor=JSON.parse(process.env.FIXTURE_ACTOR); const facts=JSON.parse(process.env.FIXTURE_FACTS);
        await new FinancialEffects(db.prisma,time).begin(actor,process.env.FIXTURE_EFFECT,facts);
        await new SimulationBroker(db.prisma,time).execute(actor,process.env.FIXTURE_EFFECT,facts);
        console.log('PERSISTED'); setInterval(()=>{},1000);`,
        {
          FIXTURE_TIME: now.toISOString(),
          FIXTURE_ACTOR: JSON.stringify(actor),
          FIXTURE_EFFECT: rows.effect.id,
          FIXTURE_FACTS: JSON.stringify(rows.simulatedFacts),
        },
      );
      expect(await db.prisma.simulationExecution.count()).toBe(1);
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseFence: 2, leaseOwner: "worker-b" },
      });
      await rows.effects.recoverInterrupted();
      await expect(rows.effects.reconcileSimulation(actor, rows.effect.id)).rejects.toThrow();
      const current = {
        ...actor,
        execution: { runId: "claimed", holder: "worker-b", generation: 2 },
      };
      const result = await rows.effects.reconcileSimulation(current, rows.effect.id);
      expect(result).toMatchObject({
        status: "completed",
        financialProviderReference: `sim_${rows.effect.id}`,
      });
      expect((await rows.effects.reconcileSimulation(current, rows.effect.id)).id).toBe(result.id);
      expect(await db.prisma.simulationExecution.count()).toBe(1);
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).status,
      ).toBe("COMMITTED");
      expect(
        await db.prisma.financialJournal.count({
          where: { effectId: rows.effect.id, event: "RECONCILED" },
        }),
      ).toBe(1);
      expect(
        (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
          .status,
      ).toBe("PAUSED");
    });
    it("proves an interrupted local simulation never accepted and safely releases its reserved risk", async () => {
      const rows = await simulatedPrepared();
      await rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts);
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseFence: 2, leaseOwner: "worker-b" },
      });
      await rows.effects.recoverInterrupted();
      const current = {
        ...actor,
        execution: { runId: "claimed", holder: "worker-b", generation: 2 },
      };
      expect(await rows.effects.reconcileSimulation(current, rows.effect.id)).toMatchObject({
        status: "failed",
        financialFailureCode: "SIMULATION_NOT_ACCEPTED",
      });
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: rows.effect.id },
          })
        ).status,
      ).toBe("RELEASED");
      await expect(
        rows.simulator.execute(actor, rows.effect.id, rows.simulatedFacts),
      ).rejects.toThrow();
      expect(await db.prisma.simulationExecution.count()).toBe(0);
    });
    it.each([true, false])(
      "recovers a deleted high-fence Run in a new Run without replay (accepted=%s)",
      async (accepted) => {
        const rows = await simulatedPrepared();
        await db.prisma.run.update({
          where: { id: "claimed" },
          data: { leaseFence: 7, leaseOwner: "worker-seven" },
        });
        const highFence = {
          ...actor,
          execution: { runId: "claimed", holder: "worker-seven", generation: 7 },
        };
        await rows.effects.prepare(
          highFence,
          rows.proposal.id,
          rows.previewed.preview?.id ?? "missing",
        );
        await rows.effects.begin(highFence, rows.effect.id, rows.simulatedFacts);
        if (accepted) await rows.simulator.execute(highFence, rows.effect.id, rows.simulatedFacts);
        const before = await db.prisma.externalEffect.findUniqueOrThrow({
          where: { id: rows.effect.id },
        });
        expect(before.financialRunFence).toBe(7);
        await db.prisma.run.delete({ where: { id: "claimed" } });
        await rows.effects.recoverInterrupted();
        await db.prisma.run.create({
          data: {
            id: "recovery",
            botId: "main",
            userId: owner,
            spaceId: "space",
            threadId: "thread",
            taskId: "task",
            status: "running",
            trigger: "message",
            leaseOwner: "recovery-worker",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 60000),
          },
        });
        const recovery = {
          ...actor,
          execution: { runId: "recovery", holder: "recovery-worker", generation: 1 },
        };
        // Inspection never requires renewed trading authority or another preview.
        await db.prisma.tradingMandate.update({
          where: { id: rows.active.id },
          data: { status: "CANCELLED", revision: { increment: 1 } },
        });
        const inspected = await rows.effects.prepare(recovery, rows.proposal.id, "expired-preview");
        expect(inspected.status).toBe("uncertain");
        const reconciled = await rows.effects.reconcileSimulation(recovery, rows.effect.id);
        expect(reconciled).toMatchObject({
          status: accepted ? "completed" : "failed",
          runId: "recovery",
          financialRunFence: 1,
          financialGeneration: before.financialGeneration + 1,
        });
        expect(reconciled.financialContext).toEqual(before.financialContext);
        expect(await db.prisma.simulationExecution.count()).toBe(accepted ? 1 : 0);
        const generation = reconciled.financialGeneration;
        expect(
          (await rows.effects.reconcileSimulation(recovery, rows.effect.id)).financialGeneration,
        ).toBe(generation);
        await expect(
          rows.effects.settle(highFence, rows.effect.id, {
            version: 1,
            status: "SUCCEEDED",
            providerReference: "late",
            code: null,
          }),
        ).rejects.toThrow();
        await expect(
          rows.simulator.execute(highFence, rows.effect.id, rows.simulatedFacts),
        ).rejects.toThrow();
        expect(
          (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: rows.active.id } }))
            .status,
        ).toBe("CANCELLED");
      },
    );
    it("refuses cross-Run reconciliation while the previous Run still has a valid lease", async () => {
      const rows = await simulatedPrepared();
      await rows.effects.begin(actor, rows.effect.id, rows.simulatedFacts);
      await rows.effects.settle(actor, rows.effect.id, {
        version: 1,
        status: "UNCERTAIN",
        providerReference: null,
        code: "PROVIDER_TIMEOUT",
      });
      await db.prisma.run.create({
        data: {
          id: "other",
          botId: "main",
          userId: owner,
          spaceId: "space",
          threadId: "thread",
          taskId: "task",
          status: "running",
          trigger: "message",
          leaseOwner: "other-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      const other = {
        ...actor,
        execution: { runId: "other", holder: "other-worker", generation: 1 },
      };
      await expect(rows.effects.reconcileSimulation(other, rows.effect.id)).rejects.toThrow(
        "valid lease",
      );
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: rows.effect.id } }))
          .status,
      ).toBe("uncertain");
    });
    async function financialAsk() {
      const rows = await financialPrepared();
      await rows.effects.review(
        actor,
        rows.effect.id,
        new ScriptedAutoReviewProvider({ decision: "ask", model: "fixture" }),
        rows.reviewContext,
      );
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
      });
      const message = await db.prisma.message.create({
        data: {
          seq: 0,
          threadId: "thread",
          runId: "claimed",
          botId: "main",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              approvalEffectId: rows.effect.id,
              text: "Review exact financial action",
              status: "pending",
              actions: [
                { id: "allow", label: "Approve" },
                { id: "deny", label: "Deny" },
                // Even an old/spoofed card cannot authorize a persistent financial allow rule.
                { id: "always", label: "Always allow" },
              ],
            },
          ],
        },
      });
      return {
        ...rows,
        answer: {
          spaceId: "space",
          threadId: "thread",
          runId: "claimed",
          messageId: message.id,
          answeredByUserId: owner,
          answer: "allow",
        },
      };
    }
    it("binds owner approval to the exact financial effect, rejects reuse and resumes under a new fence", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const rows = await financialAsk();
        expect(await answerRunInput(db.prisma, rows.answer)).toBe(true);
        const receipt = await db.prisma.externalEffect.findUniqueOrThrow({
          where: { id: rows.effect.id },
        });
        expect(receipt).toMatchObject({
          status: "approved",
          financialApprovedByUserId: owner,
          financialApprovedAt: now,
          reviewDecision: "ask",
        });
        expect(await answerRunInput(db.prisma, rows.answer)).toBe(false);
        expect(await db.prisma.actionApprovalRule.count()).toBe(0);
        expect(
          await db.prisma.financialJournal.count({
            where: { effectId: rows.effect.id, event: "APPROVED" },
          }),
        ).toBe(1);
        await db.prisma.run.update({
          where: { id: "claimed" },
          data: {
            status: "running",
            leaseOwner: "worker-b",
            leaseFence: 2,
            leaseExpiresAt: new Date(now.getTime() + 60000),
          },
        });
        const current = {
          ...actor,
          execution: { runId: "claimed", holder: "worker-b", generation: 2 },
        };
        await rows.effects.prepare(
          current,
          rows.proposal.id,
          rows.previewed.preview?.id ?? "missing",
        );
        expect((await rows.effects.begin(current, rows.effect.id, facts)).status).toBe("executing");
      } finally {
        vi.useRealTimers();
      }
    });
    it("rejects wrong-principal, wrong-conversation, blanket and expired financial approvals", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const rows = await financialAsk();
        for (const answer of [
          { ...rows.answer, answeredByUserId: "peer" },
          { ...rows.answer, threadId: "other" },
          { ...rows.answer, spaceId: "other" },
          { ...rows.answer, answer: "always" },
        ])
          expect(await answerRunInput(db.prisma, answer)).toBe(false);
        expect((await db.prisma.run.findUniqueOrThrow({ where: { id: "claimed" } })).status).toBe(
          "waiting_input",
        );
        vi.setSystemTime(new Date(now.getTime() + 600001));
        expect(await answerRunInput(db.prisma, rows.answer)).toBe(false);
        expect(
          (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: rows.effect.id } }))
            .status,
        ).toBe("intended");
        expect(await db.prisma.actionApprovalRule.count()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
    it("owner denial persists a terminal receipt without authorizing execution", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const rows = await financialAsk();
        expect(await answerRunInput(db.prisma, { ...rows.answer, answer: "deny" })).toBe(true);
        expect(
          (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: rows.effect.id } }))
            .status,
        ).toBe("denied");
        expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
        expect(
          await db.prisma.financialJournal.count({
            where: { effectId: rows.effect.id, event: "DENIED" },
          }),
        ).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
    it("uses one stable underscored client/effect identity and requires independent review before STARTED", async () => {
      const { effects, effect, proposal, previewed } = await financialPrepared();
      expect(effect.financialContext).toMatchObject({
        version: 2,
        proposalId: proposal.id,
        planVersion: 1,
        clientId: expect.stringMatching(/^rz_[a-f0-9]{10}_[a-f0-9]{10}$/),
      });
      expect(
        (await effects.prepare(actor, proposal.id, previewed.preview?.id ?? "missing")).id,
      ).toBe(effect.id);
      await expect(effects.begin(actor, effect.id, facts)).rejects.toThrow("authorized");
      expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
    });
    it.each(["deny", "ask", "pass"] as const)(
      "persists independent financial %s without allowing denial/escalation to execute",
      async (decision) => {
        const { effects, effect, reviewContext } = await financialPrepared();
        const updated = await effects.review(
          actor,
          effect.id,
          new ScriptedAutoReviewProvider({ decision, model: "fixture" }),
          reviewContext,
        );
        expect(updated.status).toBe(
          decision === "pass" ? "approved" : decision === "deny" ? "denied" : "intended",
        );
        expect(updated.reviewDecision).toBe(decision);
        if (decision !== "pass")
          await expect(effects.begin(actor, effect.id, facts)).rejects.toThrow();
        if (decision === "ask")
          await expect(
            effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext),
          ).rejects.toThrow("prior escalation");
        await expect(
          db.prisma.externalEffect.update({
            where: { id: effect.id },
            data: { reviewDecision: decision === "pass" ? "deny" : "pass" },
          }),
        ).rejects.toThrow("immutable");
        expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
        expect(
          await db.prisma.financialJournal.count({
            where: { effectId: effect.id, event: "REVIEWED" },
          }),
        ).toBe(1);
      },
    );
    it("reserves and starts atomically, persists success and prevents duplicate begin", async () => {
      const { effects, effect, reviewContext } = await financialPrepared();
      await effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext);
      expect((await effects.begin(actor, effect.id, facts)).status).toBe("executing");
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: effect.id },
          })
        ).status,
      ).toBe("RESERVED");
      await expect(effects.begin(actor, effect.id, facts)).rejects.toThrow();
      expect(
        (
          await effects.settle(actor, effect.id, {
            version: 1,
            status: "SUCCEEDED",
            providerReference: "fixture-fill",
            code: null,
          })
        ).status,
      ).toBe("completed");
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: effect.id },
          })
        ).status,
      ).toBe("COMMITTED");
      await expect(
        effects.settle(actor, effect.id, {
          version: 1,
          status: "SUCCEEDED",
          providerReference: "fixture-fill",
          code: null,
        }),
      ).rejects.toThrow();
    });
    it("rolls back reservation and STARTED when the final journal write fails", async () => {
      const { effects, effect, reviewContext } = await financialPrepared();
      await effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext);
      await db.prisma
        .$executeRaw`ALTER TABLE financial_journal ADD CONSTRAINT fixture_test_reject_started CHECK (event <> 'STARTED') NOT VALID`;
      try {
        await expect(effects.begin(actor, effect.id, facts)).rejects.toThrow();
        expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
        expect(
          (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
        ).toBe("approved");
      } finally {
        await db.prisma
          .$executeRaw`ALTER TABLE financial_journal DROP CONSTRAINT fixture_test_reject_started`;
      }
    });
    it("cannot use an old model review even after refreshing trusted broker facts", async () => {
      const rows = await financialPrepared();
      await rows.effects.review(
        actor,
        rows.effect.id,
        new ScriptedAutoReviewProvider(),
        rows.reviewContext,
      );
      const later = new Date(now.getTime() + 16000);
      const freshFacts = {
        ...facts,
        observedAt: later.toISOString(),
        specificationObservedAt: later.toISOString(),
        quote: { ...facts.quote, sourceTime: later.toISOString(), receivedAt: later.toISOString() },
      };
      await db.prisma.tradingMandate.update({
        where: { id: rows.active.id },
        data: { observedAt: later },
      });
      await expect(
        new FinancialEffects(db.prisma, () => later).begin(actor, rows.effect.id, freshFacts),
      ).rejects.toThrow("Fresh independent review");
      expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
    });
    it("emergency freeze between review and begin prevents STARTED and any risk reservation", async () => {
      const { effects, effect, active, reviewContext } = await financialPrepared();
      await effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext);
      await missions.controlMandate(owner, {
        id: active.id,
        expectedRevision: active.revision,
        action: "EMERGENCY_STOP",
      });
      await expect(effects.begin(actor, effect.id, facts)).rejects.toThrow();
      expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }))
          .financialStartedAt,
      ).toBeNull();
    });
    it("requires every authoritative effect write to own the current execution even after rereading", async () => {
      const { effects, effect, proposal, previewed, reviewContext } = await financialPrepared();
      await effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext);
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseFence: 2, leaseOwner: "worker-b" },
      });
      const workerB = {
        ...actor,
        execution: { runId: "claimed", holder: "worker-b", generation: 2 },
      };
      await effects.prepare(workerB, proposal.id, previewed.preview?.id ?? "missing");
      await effects.begin(workerB, effect.id, facts);
      await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } });
      await expect(
        effects.prepare(actor, proposal.id, previewed.preview?.id ?? "missing"),
      ).rejects.toThrow();
      await expect(
        effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext),
      ).rejects.toThrow();
      await expect(effects.begin(actor, effect.id, facts)).rejects.toThrow();
      await expect(
        effects.settle(actor, effect.id, {
          version: 1,
          status: "FAILED",
          providerReference: null,
          code: "OLD_WORKER",
        }),
      ).rejects.toThrow();
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
      ).toBe("executing");
    });
    it("keeps interrupted effects uncertain, pauses new risk and never blindly retries", async () => {
      const { effects, effect, active, reviewContext } = await financialPrepared();
      await effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext);
      await effects.begin(actor, effect.id, facts);
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseFence: 2, leaseOwner: "worker-b" },
      });
      await effects.recoverInterrupted();
      await effects.recoverInterrupted();
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
      ).toBe("uncertain");
      expect(
        (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: active.id } })).status,
      ).toBe("NEEDS_RECONCILIATION");
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: effect.id },
          })
        ).status,
      ).toBe("UNCERTAIN");
      expect(
        await db.prisma.financialJournal.count({
          where: { effectId: effect.id, event: "UNCERTAIN" },
        }),
      ).toBe(1);
      await expect(
        effects.settle(actor, effect.id, {
          version: 1,
          status: "SUCCEEDED",
          providerReference: "late",
          code: null,
        }),
      ).rejects.toThrow();
    });
    it("survives actual process death after STARTED without releasing risk or resending", async () => {
      const { effects, effect, active, reviewContext } = await financialPrepared();
      await effects.review(actor, effect.id, new ScriptedAutoReviewProvider(), reviewContext);
      await killAfterPersisted(
        `import {createDb} from '@rakazo/db'; import {FinancialEffects} from './src/financial-effects.ts';
        const db=createDb(process.env.MISSION_TEST_DATABASE_URL);
        const effects=new FinancialEffects(db.prisma,()=>new Date(process.env.FIXTURE_TIME));
        await effects.begin(JSON.parse(process.env.FIXTURE_ACTOR),process.env.FIXTURE_EFFECT,JSON.parse(process.env.FIXTURE_FACTS));
        console.log('PERSISTED'); setInterval(()=>{},1000);`,
        {
          FIXTURE_TIME: now.toISOString(),
          FIXTURE_ACTOR: JSON.stringify(actor),
          FIXTURE_EFFECT: effect.id,
          FIXTURE_FACTS: JSON.stringify(facts),
        },
      );
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
      ).toBe("executing");
      await db.prisma.run.update({
        where: { id: "claimed" },
        data: { leaseOwner: "worker-b", leaseFence: 2 },
      });
      await effects.recoverInterrupted();
      await effects.recoverInterrupted();
      expect(
        (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
      ).toBe("uncertain");
      expect(
        (
          await db.prisma.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: effect.id },
          })
        ).status,
      ).toBe("UNCERTAIN");
      expect(
        (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: active.id } })).status,
      ).toBe("NEEDS_RECONCILIATION");
      expect(
        await db.prisma.financialJournal.count({
          where: { effectId: effect.id, event: "STARTED" },
        }),
      ).toBe(1);
      await expect(
        effects.begin(
          { ...actor, execution: { runId: "claimed", holder: "worker-b", generation: 2 } },
          effect.id,
          facts,
        ),
      ).rejects.toThrow();
      await expect(
        db.prisma.externalEffect.update({
          where: { id: effect.id },
          data: { financialStartedAt: null },
        }),
      ).rejects.toThrow("immutable");
    });
    it("persists exact material terms and plan attribution without approval, reservation or mutation", async () => {
      const { service, proposal, command, preflight } = await prepared();
      expect(proposal.action).toEqual(action);
      expect(proposal.preview).toBeNull();
      expect(proposal.planVersion).toBe(1);
      expect(await service.command(actor, command, "prepare")).toEqual(proposal);
      expect(preflight).not.toHaveBeenCalled();
      expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
      expect(await db.prisma.externalEffect.count()).toBe(0);
      await expect(
        service.command(actor, { ...command, action: { ...action, volume: "0.02" } }, "prepare"),
      ).rejects.toThrow("identity changed");
    });
    it("uses trusted preflight and immutable preview versions; preview never grants authority", async () => {
      const { service, proposal, preflight } = await prepared();
      const result = TradeProposalViewSchema.parse(
        await service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
        }),
      );
      expect(preflight).toHaveBeenCalledWith(owner, action, undefined);
      expect(result).toMatchObject({
        status: "PREVIEWED",
        revision: 2,
        preview: {
          version: 1,
          authorizationGranted: false,
          actionFingerprint: proposal.actionFingerprint,
          risk: { decision: "ALLOW", incrementalRisk: "6.1" },
          expiresAt: "2026-10-09T10:00:15.000Z",
        },
      });
      const second = TradeProposalViewSchema.parse(
        await service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 2,
        }),
      );
      expect(second.preview?.version).toBe(2);
      expect(await db.prisma.tradePreview.count()).toBe(2);
      await expect(
        db.prisma.tradePreview.update({ where: { id: result.preview?.id }, data: { facts: {} } }),
      ).rejects.toThrow("immutable");
    });
    it("rejects a stale proposal revision before another provider request", async () => {
      const { service, proposal, preflight } = await prepared();
      const command = { operation: "preview", proposalId: proposal.id, expectedRevision: 1 };
      await service.command(actor, command);
      await expect(service.command(actor, command)).rejects.toThrow("revision conflict");
      expect(preflight).toHaveBeenCalledTimes(1);
    });
    it("rechecks claimed execution after provider IO and refuses stale worker results", async () => {
      const preflight = vi.fn(async () => {
        await db.prisma.run.update({
          where: { id: "claimed" },
          data: { leaseFence: 2, leaseOwner: "worker-b" },
        });
        return facts;
      });
      const { service, proposal } = await prepared(action, preflight);
      await expect(
        service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow();
      expect(await db.prisma.tradePreview.count()).toBe(0);
    });
    it("denies an unsafe stop using deterministic arithmetic rather than the rationale", async () => {
      const { service, proposal } = await prepared({ ...action, stopLoss: "2800" });
      expect(
        await service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
        }),
      ).toMatchObject({ status: "BLOCKED", preview: { risk: { decision: "DENY" } } });
    });
    it("blocks stale broker evidence, unknown mission accounting and emergency freeze", async () => {
      const { service, proposal, active } = await prepared(
        action,
        vi.fn(async () => ({ ...facts, observedAt: "2026-10-09T09:00:00Z" })),
      );
      expect(
        await service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
        }),
      ).toMatchObject({ preview: { risk: { decision: "DENY", code: "STALE_BROKER_STATE" } } });
      await db.prisma.tradingMandate.update({
        where: { id: active.id },
        data: { observedAt: null },
      });
      expect(
        await service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 2,
        }),
      ).toMatchObject({ preview: { risk: { code: "STALE_MISSION_ACCOUNTING" } } });
      await missions.controlMandate(owner, {
        id: active.id,
        expectedRevision: active.revision,
        action: "EMERGENCY_STOP",
      });
      expect((await db.prisma.accountRiskGuardrail.findFirstOrThrow()).frozen).toBe(true);
    });
    it("rejects account/symbol aliases, peer authority and model-supplied risk facts", async () => {
      const { service, command, proposal } = await prepared();
      await expect(
        service.command(
          actor,
          { ...command, action: { ...action, brokerSymbol: "XAUUSD" } },
          "other",
        ),
      ).rejects.toThrow("account-scoped");
      await expect(
        service.command({ ...actor, botId: "peer" }, { operation: "get", proposalId: proposal.id }),
      ).rejects.toThrow();
      await expect(
        service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
          facts,
        }),
      ).rejects.toThrow();
    });
    it("preserves financial proposals after chat deletion and rejects direct material rewrite", async () => {
      const { service, proposal } = await prepared();
      await expect(
        db.prisma.tradeProposal.update({
          where: { id: proposal.id },
          data: { action: { ...action, volume: "1" }, revision: { increment: 1 } },
        }),
      ).rejects.toThrow("immutable");
      await db.prisma.thread.delete({ where: { id: "thread" } });
      expect(
        await service.command(human, { operation: "get", proposalId: proposal.id }),
      ).toMatchObject({ id: proposal.id, actionFingerprint: proposal.actionFingerprint });
      expect(await db.prisma.financialJournal.count({ where: { event: "TRADE_PROPOSED" } })).toBe(
        1,
      );
    });
    it("provider failure leaves the proposal unchanged and emits no effect", async () => {
      const { service, proposal } = await prepared(
        action,
        vi.fn(async () => {
          throw new Error("Fixture unavailable");
        }),
      );
      await expect(
        service.command(actor, {
          operation: "preview",
          proposalId: proposal.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow();
      expect(
        await service.command(actor, { operation: "get", proposalId: proposal.id }),
      ).toMatchObject({ revision: 1, preview: null });
      expect(await db.prisma.externalEffect.count()).toBe(0);
    });
  });
  it("persists goal/immutable plan and an unapproved hard envelope, never guaranteeing a target", async () => {
    const { created, mandate } = await proposed();
    expect(created.targetGuaranteed).toBe(false);
    expect(mandate.status).toBe("AWAITING_APPROVAL");
    expect(mandate.approvedAt).toBeNull();
    const restored = new TradingMissions(db.prisma, () => now);
    expect(await restored.command(human, { operation: "get", goalId: created.id })).toMatchObject({
      goal: { id: created.id },
      plans: [{ version: 1 }],
      mandates: [{ fingerprint: mandate.fingerprint }],
    });
  });
  it("deduplicates a stable request but rejects changed contents", async () => {
    const one = await missions.command(actor, { operation: "goal_create", goal }, "same");
    expect(await missions.command(actor, { operation: "goal_create", goal }, "same")).toEqual(one);
    await expect(
      missions.command(
        actor,
        { operation: "goal_create", goal: { ...goal, targetProfit: "900" } },
        "same",
      ),
    ).rejects.toThrow("identity changed");
  });
  it("requires owner guardrails and exact approval; changed/reused/wrong-principal approvals fail", async () => {
    const { mandate } = await proposed();
    const input = {
      id: mandate.id,
      expectedRevision: 1,
      fingerprint: mandate.fingerprint,
      approve: true,
    };
    await expect(missions.resolveMandate(owner, input)).rejects.toThrow("guardrails");
    await missions.setAccountGuardrails(owner, limits);
    await expect(missions.resolveMandate("other", input)).rejects.toThrow();
    await expect(
      missions.resolveMandate(owner, { ...input, fingerprint: "0".repeat(64) }),
    ).rejects.toThrow("Exact");
    expect(await missions.resolveMandate(owner, input)).toMatchObject({
      status: "ACTIVE",
      revision: 2,
    });
    await expect(missions.resolveMandate(owner, input)).rejects.toThrow("Exact");
  });
  it("agent cannot self-approve, administer guardrails or inject approved fields", async () => {
    await expect(
      missions.command(actor, { operation: "mandate_approve", id: "fake" }),
    ).rejects.toThrow();
    await expect(missions.command(actor, { operation: "guardrails", limits })).rejects.toThrow();
    await expect(
      missions.command(actor, {
        operation: "goal_create",
        goal: { ...goal, approvedByUserId: owner },
      }),
    ).rejects.toThrow();
  });
  it("does not let future goals acquire current trading authority", async () => {
    const created = TradingGoalViewSchema.parse(
      await missions.command(
        actor,
        { operation: "goal_create", goal: { ...goal, startsAt: "2026-10-10T10:00:00Z" } },
        "future",
      ),
    );
    const proposedPlan = TradingPlanViewSchema.parse(
      await missions.command(actor, {
        operation: "plan_create",
        goalId: created.id,
        expectedVersion: 0,
        plan,
      }),
    );
    const mandate = TradingMandateViewSchema.parse(
      await missions.command(actor, { operation: "mandate_propose", planId: proposedPlan.id }),
    );
    await missions.setAccountGuardrails(owner, limits);
    const approved = await missions.resolveMandate(owner, {
      id: mandate.id,
      expectedRevision: 1,
      fingerprint: mandate.fingerprint,
      approve: true,
    });
    expect(approved.status).toBe("APPROVED_WAITING");
    const wake = await db.prisma.tradingMissionWake.findFirstOrThrow({
      where: { mandateId: mandate.id, kind: "START" },
    });
    await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), now);
    expect(await db.prisma.run.count({ where: { clientNonce: wake.wakeKey } })).toBe(0);
    await Promise.all([
      wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), wake.dueAt),
      wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), wake.dueAt),
    ]);
    expect(await db.prisma.run.count({ where: { clientNonce: wake.wakeKey } })).toBe(1);
    expect(
      (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: mandate.id } })).status,
    ).toBe("ACTIVE");
  });
  it("places the requested deadline on the existing job host; idle recovery schedules no model turn", async () => {
    await enqueueMissionWakes(db.prisma, jobs, undefined, now);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    const { active } = await activated();
    await enqueueMissionWakes(db.prisma, jobs, active.id, now);
    const scheduled = await db.prisma.tradingMissionWake.findMany({
      where: { mandateId: active.id },
    });
    for (const wake of scheduled)
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "trading.mission-wake",
          availableAt: wake.dueAt,
          payload: { wakeId: wake.id, scheduledFor: wake.dueAt.toISOString() },
        }),
      );
    expect(await db.prisma.run.count()).toBe(1); // Fixture Run only; enqueue is metadata.
  });
  it("restores a captured wake after chat deletion and never replays a completed wake", async () => {
    const { active } = await activated();
    const wake = await db.prisma.tradingMissionWake.findFirstOrThrow({
      where: { mandateId: active.id, kind: "START" },
    });
    await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), now);
    const first = await db.prisma.tradingMissionWake.findUniqueOrThrow({ where: { id: wake.id } });
    expect(first.runId).not.toBeNull();
    await db.prisma.thread.delete({ where: { id: "thread" } });
    expect(
      (await db.prisma.tradingMissionWake.findUniqueOrThrow({ where: { id: wake.id } })).status,
    ).toBe("DELIVERY_NEEDED");
    await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), now);
    const restored = await db.prisma.tradingMissionWake.findUniqueOrThrow({
      where: { id: wake.id },
    });
    expect(restored.runId).not.toBe(first.runId);
    await db.prisma.run.update({
      where: { id: restored.runId ?? "missing" },
      data: { status: "completed", completedAt: now },
    });
    await db.prisma.thread.deleteMany();
    await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), now);
    expect(
      (await db.prisma.tradingMissionWake.findUniqueOrThrow({ where: { id: wake.id } })).status,
    ).toBe("COMPLETED");
    expect(await db.prisma.run.count()).toBe(0);
    await expect(
      db.prisma.tradingMissionWake.update({
        where: { id: wake.id },
        data: { status: "WAITING", completedAt: null },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      db.prisma.tradingMissionWake.update({
        where: { id: wake.id },
        data: { dueAt: new Date("2026-10-10T10:00:00Z") },
      }),
    ).rejects.toThrow("immutable");
    await expect(db.prisma.tradingMissionWake.delete({ where: { id: wake.id } })).rejects.toThrow(
      "cannot be deleted",
    );
  });
  it("replaces reevaluation deadlines without extending immutable mandate authority", async () => {
    const { created, active } = await activated();
    const first = {
      ...plan,
      monitoring: { watchIds: [], reevaluationAt: ["2026-10-09T11:00:00Z"] },
    };
    await missions.command(actor, {
      operation: "plan_create",
      goalId: created.id,
      expectedVersion: 1,
      plan: first,
    });
    const old = await db.prisma.tradingMissionWake.findFirstOrThrow({
      where: { mandateId: active.id, kind: "REEVALUATE" },
    });
    await missions.command(actor, {
      operation: "plan_create",
      goalId: created.id,
      expectedVersion: 2,
      plan: { ...first, monitoring: { watchIds: [], reevaluationAt: ["2026-10-09T12:00:00Z"] } },
    });
    expect(
      (await db.prisma.tradingMissionWake.findUniqueOrThrow({ where: { id: old.id } })).status,
    ).toBe("CANCELLED");
    await wakeTradingMission(db.prisma, jobs, old.id, old.dueAt.toISOString(), old.dueAt);
    expect(await db.prisma.run.count({ where: { clientNonce: old.wakeKey } })).toBe(0);
    const next = await db.prisma.tradingMissionWake.findFirstOrThrow({
      where: { mandateId: active.id, kind: "REEVALUATE", status: "WAITING" },
    });
    expect(next.dueAt.toISOString()).toBe("2026-10-09T12:00:00.000Z");
  });
  it("expires after downtime without increasing risk and emits exactly one expiry turn", async () => {
    const { active } = await activated();
    const late = new Date("2026-10-12T10:00:00Z");
    const wakes = await db.prisma.tradingMissionWake.findMany({
      where: { mandateId: active.id },
      orderBy: { dueAt: "asc" },
    });
    for (const wake of wakes)
      await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), late);
    for (const wake of wakes)
      await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), late);
    expect(
      (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: active.id } })).status,
    ).toBe("EXPIRED");
    expect(
      await db.prisma.run.count({
        where: { clientNonce: { startsWith: `mandate:${active.id}:` } },
      }),
    ).toBe(1);
    expect(
      await db.prisma.financialJournal.count({
        where: { mandateId: active.id, event: "MISSION_EXPIRE" },
      }),
    ).toBe(1);
  });
  it("coalesces missed analysis deadlines without turning recovery into model polling", async () => {
    const { created, active } = await activated();
    const start = await db.prisma.tradingMissionWake.findFirstOrThrow({
      where: { mandateId: active.id, kind: "START" },
    });
    await wakeTradingMission(db.prisma, jobs, start.id, start.dueAt.toISOString(), now);
    const receipt = await db.prisma.tradingMissionWake.findUniqueOrThrow({
      where: { id: start.id },
    });
    await db.prisma.run.update({
      where: { id: receipt.runId ?? "missing" },
      data: { status: "completed", completedAt: now },
    });
    await missions.command(actor, {
      operation: "plan_create",
      goalId: created.id,
      expectedVersion: 1,
      plan: {
        ...plan,
        monitoring: {
          watchIds: [],
          reevaluationAt: ["2026-10-09T11:00:00Z", "2026-10-09T12:00:00Z"],
        },
      },
    });
    const missed = await db.prisma.tradingMissionWake.findMany({
      where: { mandateId: active.id, kind: "REEVALUATE" },
      orderBy: { dueAt: "asc" },
    });
    const resumed = new Date("2026-10-09T13:00:00Z");
    for (const wake of missed)
      await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), resumed);
    expect(
      await db.prisma.tradingMissionWake.count({
        where: { mandateId: active.id, status: "COALESCED" },
      }),
    ).toBe(1);
    expect(
      await db.prisma.run.count({
        where: { clientNonce: { startsWith: `mandate:${active.id}:plan:` } },
      }),
    ).toBe(1);
  });
  it("recovers a durable Run after actual process death between commit and enqueue", async () => {
    const { active } = await activated();
    const wake = await db.prisma.tradingMissionWake.findFirstOrThrow({
      where: { mandateId: active.id, kind: "START" },
    });
    const script = `import {createDb} from '@rakazo/db'; import {wakeTradingMission} from './src/trading-mission-wakes.ts';
      const db = createDb(process.env.MISSION_TEST_DATABASE_URL);
      const jobs = {cancel: async()=>{}, close: async()=>{}, enqueue: async()=> { console.log('PERSISTED'); setInterval(()=>{},1000); await new Promise(()=>{}); }};
      await wakeTradingMission(db.prisma,jobs,process.env.FIXTURE_WAKE,process.env.FIXTURE_TIME,new Date(process.env.FIXTURE_TIME));`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: new URL("../", import.meta.url),
        env: {
          PATH: process.env.PATH,
          MISSION_TEST_DATABASE_URL: url,
          FIXTURE_WAKE: wake.id,
          FIXTURE_TIME: wake.dueAt.toISOString(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Fixture child persistence timed out")),
          15000,
        );
        child.stdout.on("data", (data: Buffer) => {
          if (data.toString().includes("PERSISTED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Fixture child failed"));
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Fixture child exited before persistence"));
        });
      });
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        if (child.kill("SIGKILL")) await exited;
      }
    }
    const captured = await db.prisma.tradingMissionWake.findUniqueOrThrow({
      where: { id: wake.id },
    });
    expect(captured.status).toBe("QUEUED");
    expect(captured.runId).not.toBeNull();
    await createJobReconciler({ prisma: db.prisma, jobs }).reconcileOnce();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: captured.runId } }),
    );
    await wakeTradingMission(db.prisma, jobs, wake.id, wake.dueAt.toISOString(), now);
    expect(await db.prisma.run.count({ where: { clientNonce: wake.wakeKey } })).toBe(1);
  });
  it("stale worker is rejected even after reading current records", async () => {
    const { created } = await proposed();
    await db.prisma.run.update({
      where: { id: "claimed" },
      data: { leaseFence: 2, leaseOwner: "worker-b" },
    });
    await missions.command(human, { operation: "get", goalId: created.id });
    for (const command of [
      { operation: "list" },
      { operation: "goal_create", goal },
      { operation: "plan_create", goalId: created.id, expectedVersion: 1, plan },
    ])
      await expect(missions.command(actor, command)).rejects.toThrow();
  });
  it("rejects expanded scope and stale plans; revising the plan cannot enlarge an active mandate", async () => {
    const { created, mandate } = await activated();
    await expect(
      missions.command(actor, {
        operation: "plan_create",
        goalId: created.id,
        expectedVersion: 0,
        plan,
      }),
    ).rejects.toThrow("revision");
    await expect(
      missions.command(actor, {
        operation: "plan_create",
        goalId: created.id,
        expectedVersion: 1,
        plan: { ...plan, riskProposal: { ...draft, allowedInstruments: ["other"] } },
      }),
    ).rejects.toThrow("scope");
    await missions.command(actor, {
      operation: "plan_create",
      goalId: created.id,
      expectedVersion: 1,
      plan: { ...plan, riskProposal: { ...draft, maxRiskPerTrade: "10" } },
    });
    expect(
      (await db.prisma.tradingMandate.findUniqueOrThrow({ where: { id: mandate.id } })).envelope,
    ).toMatchObject({ maxRiskPerTrade: "20" });
    await expect(
      db.prisma.tradingPlan.update({ where: { id: mandate.planId }, data: { definition: plan } }),
    ).rejects.toThrow("immutable");
    await expect(
      db.prisma.tradingMandate.update({
        where: { id: mandate.id },
        data: { envelope: { ...draft, maxMissionLoss: "500" } },
      }),
    ).rejects.toThrow("immutable");
  });
  it("survives ordinary chat deletion without cancelling the mission", async () => {
    const { created, mandate } = await activated();
    await db.prisma.thread.delete({ where: { id: "thread" } });
    expect(await missions.command(human, { operation: "get", goalId: created.id })).toMatchObject({
      mandates: [{ id: mandate.id, status: "ACTIVE" }],
    });
  });
  it("owner stop freezes the account atomically and preserves revision consistency", async () => {
    const { active } = await activated();
    expect(
      await missions.controlMandate(owner, {
        id: active.id,
        expectedRevision: 2,
        action: "EMERGENCY_STOP",
      }),
    ).toMatchObject({ status: "PAUSED", revision: 3 });
    expect(await missions.accountGuardrails(owner, "account", "SIMULATION")).toMatchObject({
      frozen: true,
      revision: 2,
    });
    expect(
      await missions.setAccountGuardrails(owner, { ...limits, frozen: true, revision: 2 }),
    ).toMatchObject({ frozen: true, revision: 3 });
    await expect(
      missions.controlMandate(owner, { id: active.id, expectedRevision: 2, action: "CANCEL" }),
    ).rejects.toThrow("revision");
    expect(
      await missions.controlMandate(owner, {
        id: active.id,
        expectedRevision: 3,
        action: "CANCEL",
      }),
    ).toMatchObject({ status: "CANCELLED" });
  });
  it("does not silently upgrade simulation to LIVE or activate expired mandates", async () => {
    await expect(missions.setAccountGuardrails(owner, { ...limits, mode: "LIVE" })).rejects.toThrow(
      "disabled",
    );
    const { mandate } = await proposed();
    await missions.setAccountGuardrails(owner, limits);
    const expired = new TradingMissions(db.prisma, () => new Date("2026-10-12T10:00:00Z"));
    await expect(
      expired.resolveMandate(owner, {
        id: mandate.id,
        expectedRevision: 1,
        fingerprint: mandate.fingerprint,
        approve: true,
      }),
    ).rejects.toThrow("expired");
    await expect(db.prisma.tradingGoal.updateMany({ data: { mode: "LIVE" } })).rejects.toThrow(
      "immutable",
    );
  });
});
