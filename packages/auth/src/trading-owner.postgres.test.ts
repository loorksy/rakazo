import {
  createDb,
  initializeTradingOwner,
  provisionTradingOwner,
  requireTradingMembership,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "./index.js";

const databaseUrl = process.env.TRADING_TEST_DATABASE_URL;
const suite = databaseUrl ? describe.sequential : describe.skip;
const proof = "fixture-only-owner-bootstrap-proof-not-a-secret";

suite("trading owner enforcement (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createAuth>;
  beforeAll(() => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
      throw new Error("A dedicated fixture database ending in _test is required");
    db = createDb(databaseUrl);
    auth = createAuth(db.prisma, {
      ownerOnly: true,
      secret: "fixture-only-auth-secret-long-enough-for-tests",
      baseURL: "http://localhost:3100",
      webOrigin: "http://localhost:5173",
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });
  });
  beforeEach(async () => {
    await db.prisma.$executeRaw`TRUNCATE TABLE "user", organization, deployment_settings CASCADE`;
    await initializeTradingOwner(db.prisma, proof);
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.$executeRaw`TRUNCATE TABLE "user", organization, deployment_settings CASCADE`;
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const register = (email: string, suppliedProof = proof) =>
    auth.handler(
      new Request("http://localhost:3100/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
          "x-rakazo-owner-bootstrap": suppliedProof,
        },
        body: JSON.stringify({ name: "Fixture owner", email, password: "fixture-only-password" }),
      }),
    );
  it("requires an operator setup proof and does not persist it in user data", async () => {
    expect((await register("owner@example.test", "invalid")).status).toBe(403);
    expect(await db.prisma.user.count()).toBe(0);
    const settings = await db.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    expect(settings.ownerBootstrapProofHash).not.toContain(proof);
  });
  it("provisions the server Trading Agent and private environment on the first admitted session", async () => {
    const response = await register("owner@example.test");
    expect(response.status).toBe(200);
    const settings = await db.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    expect(settings.ownerBootstrapCompleted).toBe(true);
    expect(settings.ownerBootstrapProofHash).toBeNull();
    expect(settings.signupsEnabled).toBe(false);
    expect(await db.prisma.bot.count()).toBe(0);
    const results = await Promise.all([
      provisionTradingOwner(db.prisma, settings.ownerUserId!),
      provisionTradingOwner(db.prisma, settings.ownerUserId!),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.prisma.bot.count()).toBe(0);
  });
  it("concurrent registration admits exactly one human across database connections", async () => {
    const responses = await Promise.all([register("a@example.test"), register("b@example.test")]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(await db.prisma.user.count()).toBe(1);
  });
  it("blocks hidden direct inserts and service-to-human conversion after claiming", async () => {
    expect((await register("owner@example.test")).status).toBe(200);
    await expect(
      db.prisma.user.create({
        data: { id: "second", name: "Second", email: "second@example.test" },
      }),
    ).rejects.toThrow();
    await db.prisma.user.create({
      data: { id: "service", name: "Service", email: "fixture@messaging.invalid" },
    });
    await expect(
      db.prisma.user.update({ where: { id: "service" }, data: { email: "second@example.test" } }),
    ).rejects.toThrow();
  });
  it("owner loss is recovery state, not public registration", async () => {
    expect((await register("owner@example.test")).status).toBe(200);
    await db.prisma.user.deleteMany();
    await initializeTradingOwner(db.prisma, proof);
    expect((await register("replacement@example.test")).status).not.toBe(200);
    expect(await db.prisma.user.count()).toBe(0);
  });
  it("rejects foreign principals and foreign spaces for all session-scoped access", async () => {
    expect((await register("owner@example.test")).status).toBe(200);
    const settings = await db.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    await expect(requireTradingMembership(db.prisma, "other-human")).rejects.toThrow();
    await expect(
      requireTradingMembership(db.prisma, settings.ownerUserId!, "foreign-space"),
    ).rejects.toThrow();
    expect(
      (await requireTradingMembership(db.prisma, settings.ownerUserId!)).isDeploymentOwner,
    ).toBe(true);
  });
});
