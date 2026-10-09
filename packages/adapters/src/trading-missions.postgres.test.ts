import type {
  AccountRiskGuardrails,
  TradingMandateEnvelope,
  TradingPlanInput,
} from "@rakazo/contracts";
import {
  TradingGoalViewSchema,
  TradingMandateViewSchema,
  TradingPlanViewSchema,
} from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChartActor } from "./cloud-charts.js";
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

suite("owner-only durable trading goals/plans/mandates", () => {
  let db: ReturnType<typeof createDb>;
  let missions: TradingMissions;
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE trading_risk_reservations, trading_mandates, trading_plans, trading_goals, account_risk_guardrails, financial_journal, external_effects, trading_connections, organization, deployment_settings CASCADE`;
  beforeAll(() => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("Dedicated fixture _test database required");
    db = createDb(url);
    missions = new TradingMissions(db.prisma, () => now);
  });
  beforeEach(async () => {
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
  async function proposed() {
    const created = TradingGoalViewSchema.parse(
      await missions.command(actor, { operation: "goal_create", goal }, "request"),
    );
    const createdPlan = TradingPlanViewSchema.parse(
      await missions.command(actor, {
        operation: "plan_create",
        goalId: created.id,
        expectedVersion: 0,
        plan,
      }),
    );
    const mandate = TradingMandateViewSchema.parse(
      await missions.command(actor, { operation: "mandate_propose", planId: createdPlan.id }),
    );
    return { created, createdPlan, mandate };
  }
  async function activated() {
    const rows = await proposed();
    await missions.setAccountGuardrails(owner, limits);
    const active = await missions.resolveMandate(owner, {
      id: rows.mandate.id,
      expectedRevision: 1,
      fingerprint: rows.mandate.fingerprint,
      approve: true,
    });
    return { ...rows, active };
  }
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
    await expect(
      missions.resolveMandate(owner, {
        id: mandate.id,
        expectedRevision: 1,
        fingerprint: mandate.fingerprint,
        approve: true,
      }),
    ).rejects.toThrow("has not started");
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
