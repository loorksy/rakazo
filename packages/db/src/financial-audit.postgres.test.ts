import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";

const url = process.env.FINANCIAL_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("independent financial audit retention (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const context = {
    version: 1,
    ownerUserId: "fixture-owner",
    botId: "fixture-bot",
    accountId: "fixture-account",
    mode: "SIMULATION",
    actionFingerprint: "a".repeat(64),
    authorizationId: "fixture-approval",
    policyVersion: "financial-v1",
  };
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE financial_journal, external_effects, organization, deployment_settings CASCADE`;
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
        ownerUserId: "fixture-owner",
        ownerSpaceId: "fixture-space",
        ownerBootstrapCompleted: true,
      },
    });
    await db.prisma.organization.create({
      data: { id: "fixture-org", slug: "fixture-org", name: "Fixture", createdAt: new Date() },
    });
    await db.prisma.space.create({
      data: { id: "fixture-space", organizationId: "fixture-org", name: "Fixture" },
    });
    await db.prisma.bot.create({
      data: {
        id: "fixture-bot",
        spaceId: "fixture-space",
        userId: "fixture-owner",
        name: "Fixture",
        color: "blue",
        spawnKey: "trading:main:v1",
      },
    });
    const thread = await db.prisma.thread.create({
      data: { botId: "fixture-bot", userId: "fixture-owner", spaceId: "fixture-space" },
    });
    const task = await db.prisma.task.create({
      data: {
        id: "fixture-task",
        spaceId: "fixture-space",
        botId: "fixture-bot",
        userId: "fixture-owner",
        threadId: thread.id,
        prompt: "Fixture",
        status: "running",
      },
    });
    await db.prisma.run.create({
      data: {
        id: "fixture-run",
        taskId: task.id,
        spaceId: "fixture-space",
        botId: "fixture-bot",
        userId: "fixture-owner",
        threadId: thread.id,
        trigger: "user",
        status: "running",
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
  const effect = () =>
    db.prisma.externalEffect.create({
      data: {
        id: "fixture-effect",
        spaceId: "fixture-space",
        runId: "fixture-run",
        kind: "financial.execute",
        idempotencyKey: "fixture-effect-key",
        status: "intended",
        request: { operation: "OPEN", volume: "0.01" },
        financialContext: context,
      },
    });
  const journal = () =>
    db.prisma.financialJournal.create({
      data: {
        ownerUserId: "fixture-owner",
        accountId: "fixture-account",
        mode: "SIMULATION",
        effectId: "fixture-effect",
        event: "PROPOSED",
        entry: context,
      },
    });
  it("keeps financial identities and journal after Run, Bot and Space deletion", async () => {
    await effect();
    const entry = await journal();
    await db.prisma.run.delete({ where: { id: "fixture-run" } });
    expect(
      (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: "fixture-effect" } })).runId,
    ).toBeNull();
    await db.prisma.bot.delete({ where: { id: "fixture-bot" } });
    await db.prisma.space.delete({ where: { id: "fixture-space" } });
    const retained = await db.prisma.externalEffect.findUniqueOrThrow({
      where: { id: "fixture-effect" },
    });
    expect(retained.spaceId).toBeNull();
    expect(retained.financialContext).toEqual(context);
    expect(
      (await db.prisma.financialJournal.findUniqueOrThrow({ where: { id: entry.id } })).entry,
    ).toEqual(context);
  });
  it("rejects material effect rewriting and deletion while allowing delivery linkage removal", async () => {
    await effect();
    for (const data of [
      { request: { volume: "10" } },
      { financialContext: { ...context, accountId: "foreign" } },
      { idempotencyKey: "new-key" },
      { kind: "read" },
    ])
      await expect(
        db.prisma.externalEffect.update({ where: { id: "fixture-effect" }, data }),
      ).rejects.toThrow("immutable");
    await expect(
      db.prisma.externalEffect.delete({ where: { id: "fixture-effect" } }),
    ).rejects.toThrow("cannot be deleted");
    await expect(
      db.prisma.externalEffect.update({
        where: { id: "fixture-effect" },
        data: { runId: null, spaceId: null },
      }),
    ).resolves.toMatchObject({ runId: null });
  });
  it("makes financial journal immutable and isolates mode values", async () => {
    const entry = await journal();
    await expect(
      db.prisma.financialJournal.update({ where: { id: entry.id }, data: { event: "APPROVED" } }),
    ).rejects.toThrow("immutable");
    await expect(db.prisma.financialJournal.delete({ where: { id: entry.id } })).rejects.toThrow(
      "immutable",
    );
    await expect(
      db.prisma.financialJournal.create({
        data: {
          ownerUserId: "fixture-owner",
          accountId: "fixture-account",
          mode: "AUTO",
          effectId: "fixture-effect",
          event: "PROPOSED",
          entry: {},
        },
      }),
    ).rejects.toThrow();
  });
});
