import type {
  FinancialAction,
  FinancialRiskFacts,
  TradingMandateEnvelope,
} from "@rakazo/contracts";
import { FinancialRiskFactsSchema, TradingMandateEnvelopeSchema } from "@rakazo/contracts";
import {
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountRiskLedger } from "./account-risk-ledger.js";
import type { ChartActor } from "./cloud-charts.js";

const url = process.env.RISK_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const now = new Date("2026-10-09T10:00:00Z");
const owner = "fixture-owner";
suite("atomic account risk ledger (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let envelope: TradingMandateEnvelope;
  let facts: FinancialRiskFacts;
  let action: FinancialAction;
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE trading_risk_reservations, trading_mandates, trading_plans, trading_goals, account_risk_guardrails, financial_journal, external_effects, trading_connections, organization, deployment_settings CASCADE`;
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
        spawnKey: "trading:main:v1",
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
      mode: "SIMULATION",
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
      mode: "SIMULATION",
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
        mode: "SIMULATION",
        limits: {
          version: 1,
          accountId: "fixture-account",
          mode: "SIMULATION",
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
    const fp = tradingMandateFingerprint(approved);
    await db.prisma.tradingGoal.create({
      data: {
        id: `goal-${id}`,
        ownerUserId: owner,
        botId: "fixture-main",
        accountId: "fixture-account",
        mode: approved.mode,
        definition: { objective: "Attempt profit; not guaranteed" },
      },
    });
    await db.prisma.tradingPlan.create({
      data: {
        id: `plan-${id}`,
        goalId: `goal-${id}`,
        version: 1,
        definition: { summary: "Fixture bounded plan" },
      },
    });
    await db.prisma.tradingMandate.create({
      data: {
        id: id,
        ownerUserId: owner,
        botId: "fixture-main",
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
        botId: "fixture-main",
        userId: owner,
        threadId: "fixture-thread",
        prompt: "Fixture",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        taskId: task.id,
        spaceId: "fixture-space",
        botId: "fixture-main",
        userId: owner,
        threadId: "fixture-thread",
        trigger: "user",
        status: "running",
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 120000),
      },
    });
    const material = { ...action, mode: approved.mode };
    const actionFp = financialActionFingerprint(material);
    const effect = await db.prisma.externalEffect.create({
      data: {
        spaceId: "fixture-space",
        runId: run.id,
        kind: "financial.execute",
        status: "approved",
        idempotencyKey: `effect-${id}`,
        request: material,
        financialGeneration: 1,
        financialContext: {
          version: 1,
          ownerUserId: owner,
          botId: "fixture-main",
          accountId: "fixture-account",
          mode: approved.mode,
          actionFingerprint: actionFp,
          authorizationId: id,
          policyVersion: "financial-v1",
        },
      },
    });
    const actor: ChartActor = {
      ownerUserId: owner,
      botId: "fixture-main",
      execution: { runId: run.id, holder: "fixture-worker", generation: 1 },
    };
    return { actor, effect, mandateId: id };
  }
  const ledger = () => new AccountRiskLedger(db.prisma, () => now);
  it("serializes simultaneous missions so only one can reserve the last account capacity", async () => {
    const a = await claimed("mission-a");
    const b = await claimed("mission-b");
    const results = await Promise.allSettled([
      ledger().reserve(a.actor, a.effect.id, a.mandateId, facts),
      ledger().reserve(b.actor, b.effect.id, b.mandateId, facts),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rows = await db.prisma.tradingRiskReservation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.risk.toFixed()).toBe("11.2");
    expect(await db.prisma.financialJournal.count({ where: { event: "RISK_RESERVED" } })).toBe(1);
  });
  it("deduplicates identical reservations but never accepts a stale execution after takeover", async () => {
    const a = await claimed("mission-a");
    const first = await ledger().reserve(a.actor, a.effect.id, a.mandateId, facts);
    expect((await ledger().reserve(a.actor, a.effect.id, a.mandateId, facts)).id).toBe(first.id);
    await db.prisma.run.update({
      where: { id: a.actor.execution?.runId },
      data: { leaseFence: 2, leaseOwner: "new-worker" },
    });
    await db.prisma.run.findUniqueOrThrow({ where: { id: a.actor.execution?.runId } });
    await expect(ledger().reserve(a.actor, a.effect.id, a.mandateId, facts)).rejects.toThrow();
    expect(await db.prisma.tradingRiskReservation.count()).toBe(1);
  });
  it("requires exact human approval and refuses LIVE even with an approved LIVE envelope", async () => {
    const draft = await claimed("draft", {}, "AWAITING_APPROVAL");
    await expect(
      ledger().reserve(draft.actor, draft.effect.id, draft.mandateId, facts),
    ).rejects.toThrow("user-approved");
    const live = await claimed("live", { mode: "LIVE" });
    await db.prisma.accountRiskGuardrail.create({
      data: {
        ownerUserId: owner,
        accountId: "fixture-account",
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
    await expect(
      ledger().reserve(live.actor, live.effect.id, live.mandateId, facts),
    ).rejects.toThrow("LIVE trading disabled");
    expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
  });
  it("keeps simulation capacity separate from live and counts uncertain reserved risk", async () => {
    const a = await claimed("mission-a");
    await db.prisma.tradingRiskReservation.create({
      data: {
        ownerUserId: owner,
        accountId: "fixture-account",
        mode: "LIVE",
        mandateId: "foreign-live",
        effectId: "foreign-live",
        actionFingerprint: "a".repeat(64),
        kind: "PENDING",
        risk: "1000",
        exposure: "100000",
        margin: "1000",
        executionGeneration: 1,
        status: "UNCERTAIN",
      },
    });
    await expect(ledger().reserve(a.actor, a.effect.id, a.mandateId, facts)).resolves.toMatchObject(
      { mode: "SIMULATION" },
    );
    const b = await claimed("mission-b");
    await db.prisma.tradingRiskReservation.updateMany({
      where: { mode: "SIMULATION" },
      data: { status: "UNCERTAIN" },
    });
    await expect(ledger().reserve(b.actor, b.effect.id, b.mandateId, facts)).rejects.toThrow(
      "reserved risk",
    );
  });
  it("blocks new risk under account freeze and ambiguous account state", async () => {
    const a = await claimed("mission-a");
    await db.prisma.accountRiskGuardrail.updateMany({ data: { frozen: true } });
    await expect(ledger().reserve(a.actor, a.effect.id, a.mandateId, facts)).rejects.toThrow(
      "frozen",
    );
    await db.prisma.accountRiskGuardrail.updateMany({ data: { frozen: false } });
    await expect(
      ledger().reserve(a.actor, a.effect.id, a.mandateId, {
        ...facts,
        observedAt: "2026-10-09T09:00:00Z",
      }),
    ).rejects.toThrow("STALE_BROKER_STATE");
    expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
  });
  it("requires exact verified account-scoped symbols, never a guessed alias", async () => {
    const a = await claimed("mission-a");
    await db.prisma.brokerInstrument.update({
      where: { id: "gold" },
      data: { brokerSymbol: "XAUUSD" },
    });
    await expect(ledger().reserve(a.actor, a.effect.id, a.mandateId, facts)).rejects.toThrow(
      "Verified exact broker symbol",
    );
    expect(await db.prisma.tradingRiskReservation.count()).toBe(0);
  });
  it("cannot mutate an approved envelope, approval identity or historical plan version", async () => {
    await claimed("mission-a");
    await expect(
      db.prisma.tradingMandate.update({
        where: { id: "mission-a" },
        data: { envelope: { ...envelope, maxMissionLoss: "1000" } },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      db.prisma.tradingMandate.update({
        where: { id: "mission-a" },
        data: { approvedByUserId: "foreign" },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      db.prisma.tradingPlan.update({
        where: { id: "plan-mission-a" },
        data: { definition: { summary: "overwrite" } },
      }),
    ).rejects.toThrow("immutable");
    await db.prisma.tradingPlan.create({
      data: {
        goalId: "goal-mission-a",
        version: 2,
        definition: { summary: "Voluntary risk reduction" },
      },
    });
    expect(await db.prisma.tradingPlan.count()).toBe(2);
  });
});
