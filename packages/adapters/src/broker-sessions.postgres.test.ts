import { spawn } from "node:child_process";
import type { BrokerEvent, BrokerProvider, BrokerReadSession } from "@rakazo/adapter-kit";
import { BrokerQuoteSchema, TradingCapabilitiesSchema } from "@rakazo/contracts";
import {
  claimBrokerSession,
  createDb,
  heartbeatBrokerSession,
  releaseBrokerSession,
  withBrokerSessionFence,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { followBrokerData } from "./broker-stream.js";
import { BrokerConnectionSupervisor } from "./broker-supervisor.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { withSecretPersistence } from "./secret-persistence.js";
import { EncryptedSecretStore } from "./secrets.js";
import { TradingConnections } from "./trading-connections.js";

const databaseUrl = process.env.BROKER_TEST_DATABASE_URL;
const suite = databaseUrl ? describe.sequential : describe.skip;
const owner = "fixture-owner";
const credential = "fixture-only-broker-sentinel-never-output";
const initialTime = new Date("2026-10-09T00:00:00Z");

suite("protected broker sessions (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let secrets: EncryptedSecretStore;
  let accountId: string;
  const supervisors: BrokerConnectionSupervisor[] = [];
  const reset = async () =>
    db.prisma
      .$executeRaw`TRUNCATE trading_connections, broker_session_leases, broker_read_requests, broker_instruments, broker_market_subscriptions, deployment_settings CASCADE`;
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated fixture database ending _test required");
    db = createDb(databaseUrl);
    secrets = new EncryptedSecretStore("fixture-only-encryption-key-long-enough");
    await secrets.start();
  });
  beforeEach(async () => {
    for (const supervisor of supervisors.splice(0)) await supervisor.close();
    await reset();
    await db.prisma.deploymentSettings.create({
      data: {
        id: "default",
        singleOwnerEnforced: true,
        ownerUserId: owner,
        ownerBootstrapCompleted: true,
      },
    });
    const connections = new TradingConnections(withSecretPersistence(db.prisma, secrets), secrets);
    ({ id: accountId } = await connections.save(owner, "fixture-space", {
      label: "Fixture",
      providerAccountId: "remote",
      token: credential,
    }));
  });
  afterAll(async () => {
    for (const supervisor of supervisors) await supervisor.close();
    if (db) {
      await reset();
      await secrets.close();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  const readRequest = (status = "PENDING") =>
    db.prisma.brokerReadRequest.create({
      data: {
        accountId,
        ownerUserId: owner,
        operation: "account",
        parameters: { accountId, operation: "account" },
        status,
        deadline: new Date(initialTime.getTime() + 120000),
      },
    });

  it("claims exactly one account socket under concurrent workers", async () => {
    const tokens = await Promise.all([
      claimBrokerSession(db.prisma, accountId, "a", initialTime),
      claimBrokerSession(db.prisma, accountId, "b", initialTime),
    ]);
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect(tokens.find(Boolean)?.generation).toBe(1);
  });
  it("preserves a current claim and fences every stale write after takeover even on fresh reads", async () => {
    const a = await claimBrokerSession(db.prisma, accountId, "a", initialTime);
    expect(a).not.toBeNull();
    if (!a) throw new Error("Missing fixture token");
    expect(await claimBrokerSession(db.prisma, accountId, "a", initialTime)).toEqual(a);
    const later = new Date(initialTime.getTime() + 31000);
    const b = await claimBrokerSession(db.prisma, accountId, "b", later);
    expect(b?.generation).toBe(a.generation + 1);
    await db.prisma.brokerSessionLease.findUniqueOrThrow({ where: { accountId } });
    for (const state of ["CONNECTED", "DISCONNECTED", "RECONNECTING"])
      await expect(
        withBrokerSessionFence(
          db.prisma,
          a,
          (tx) => tx.brokerSessionLease.update({ where: { accountId }, data: { state } }),
          later,
        ),
      ).rejects.toThrow("stale or revoked");
    await expect(heartbeatBrokerSession(db.prisma, a, later)).rejects.toThrow("stale or revoked");
    await expect(releaseBrokerSession(db.prisma, a, later)).rejects.toThrow("stale or revoked");
    expect(
      (await db.prisma.brokerSessionLease.findUniqueOrThrow({ where: { accountId } })).holder,
    ).toBe("b");
  });
  it("bounds lease lifetimes including renewals before touching storage", async () => {
    const token = await claimBrokerSession(db.prisma, accountId, "fixture", initialTime);
    if (!token) throw new Error("Missing token");
    for (const ttl of [0, 60001, Number.NaN, Number.POSITIVE_INFINITY, 1000.5]) {
      await expect(
        claimBrokerSession(db.prisma, accountId, "fixture", initialTime, ttl),
      ).rejects.toThrow("Invalid broker lease");
      expect(() => heartbeatBrokerSession(db.prisma, token, initialTime, ttl)).toThrow(
        "Invalid broker lease",
      );
    }
  });
  it("requires the claimed credential generation on writes after rotation", async () => {
    const a = await claimBrokerSession(db.prisma, accountId, "a", initialTime);
    if (!a) throw new Error("Missing token");
    await db.prisma.tradingConnection.update({
      where: { id: accountId },
      data: { credentialVersion: { increment: 1 } },
    });
    await expect(
      withBrokerSessionFence(db.prisma, a, async () => "must not run", initialTime),
    ).rejects.toThrow("stale or revoked");
    const next = await claimBrokerSession(db.prisma, accountId, "a", initialTime);
    expect(next?.generation).toBe(a.generation + 1);
  });
  it("revocation removes credentials, retains identity and invalidates active writes", async () => {
    const a = await claimBrokerSession(db.prisma, accountId, "a", initialTime);
    if (!a) throw new Error("Missing token");
    const connections = new TradingConnections(withSecretPersistence(db.prisma, secrets), secrets);
    await connections.revoke(owner, accountId);
    expect(
      (await db.prisma.tradingConnection.findUniqueOrThrow({ where: { id: accountId } }))
        .ciphertext,
    ).toBe("");
    await expect(heartbeatBrokerSession(db.prisma, a, initialTime)).rejects.toThrow(
      "stale or revoked",
    );
    await expect(claimBrokerSession(db.prisma, accountId, "b", initialTime)).rejects.toThrow(
      "stale or revoked",
    );
  });
  it("rejects foreign principals and never exposes stored broker secrets", async () => {
    const connections = new TradingConnections(db.prisma, secrets);
    await expect(connections.list("foreign")).rejects.toThrow("Owner session required");
    const view = JSON.stringify(await connections.list(owner));
    expect(view).not.toContain(credential);
    expect(view).not.toContain("ciphertext");
    expect(await db.prisma.botSecret.count()).toBe(0);
    expect(await db.prisma.agentSecret.count()).toBe(0);
  });
  it("recovers STARTED reads after actual worker process death without reusing ownership", async () => {
    const request = await readRequest();
    const script = `import { createDb, claimBrokerSession, withBrokerSessionFence } from '@rakazo/db';
      const db = createDb(process.env.BROKER_TEST_DATABASE_URL);
      const token = await claimBrokerSession(db.prisma, process.env.FIXTURE_ACCOUNT, 'child', new Date('${initialTime.toISOString()}'));
      await withBrokerSessionFence(db.prisma, token, tx => tx.brokerReadRequest.update({where:{id:process.env.FIXTURE_REQUEST},data:{status:'STARTED',claimedGeneration:token.generation}}), new Date('${initialTime.toISOString()}'));
      console.log('CLAIMED'); setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, FIXTURE_ACCOUNT: accountId, FIXTURE_REQUEST: request.id },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Child claim timed out"));
      }, 10000);
      child.stdout.on("data", (value: Buffer) => {
        if (value.toString().includes("CLAIMED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== null) {
          clearTimeout(timer);
          reject(new Error("Child exited before claim"));
        }
      });
    });
    const died = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await died;
    const token = await claimBrokerSession(
      db.prisma,
      accountId,
      "replacement",
      new Date(initialTime.getTime() + 31000),
    );
    expect(token?.generation).toBe(2);
    expect(
      (await db.prisma.brokerReadRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
    ).toBe("PENDING");
  });
  function providerFixture() {
    let clock = initialTime;
    let listener: ((event: BrokerEvent) => void) | undefined;
    const session: BrokerReadSession = {
      accountId,
      account: vi.fn<BrokerReadSession["account"]>(async () => ({
        accountId,
        currency: "USD",
        balance: "10000",
        equity: "10000",
        margin: "0",
        freeMargin: "10000",
        environment: "DEMO",
        accountMode: "HEDGING",
        platform: "mt5",
        tradingAllowed: true,
        observedAt: initialTime.toISOString(),
      })),
      positions: vi.fn(async () => []),
      orders: vi.fn(async () => []),
      symbols: vi.fn(async () => ["GOLD.a", "EURUSDm"]),
      specification: vi.fn<BrokerReadSession["specification"]>(async (symbol) => ({
        accountId,
        symbol,
        description: symbol,
        baseCurrency: null,
        quoteCurrency: "USD",
        tickSize: "0.01",
        minVolume: "0.01",
        maxVolume: "100",
        volumeStep: "0.01",
        digits: 2,
        stopsLevel: 10,
        tradeMode: "SYMBOL_TRADE_MODE_FULL",
        orderTypes: ["MARKET"],
        fillingModes: [],
        tradingSessions: null,
        verifiedAt: initialTime.toISOString(),
      })),
      quote: vi.fn<BrokerReadSession["quote"]>(async (symbol, instrumentId) =>
        BrokerQuoteSchema.parse({
          version: 1,
          provider: "metaapi",
          accountId,
          instrumentId,
          brokerSymbol: symbol,
          bid: "2700",
          ask: "2700.1",
          sourceTime: initialTime.toISOString(),
          receivedAt: initialTime.toISOString(),
          revision: "q1",
        }),
      ),
      candles: vi.fn(async () => []),
      capabilities: vi.fn(async () =>
        TradingCapabilitiesSchema.parse({
          version: 1,
          provider: "metaapi",
          accountId,
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
          verifiedAt: initialTime.toISOString(),
          revision: "read-v1",
        }),
      ),
      subscribe: vi.fn<BrokerReadSession["subscribe"]>(async (_symbols, callback) => {
        listener = callback;
        return async () => {};
      }),
      close: vi.fn(async () => {}),
    };
    const provider: BrokerProvider = {
      id: "metaapi",
      connect: vi.fn(async (input) => {
        expect(await input.resolveCredential()).toBe(credential);
        return session;
      }),
    };
    const realtime = new InMemoryRealtimeFanout();
    const supervisor = new BrokerConnectionSupervisor(
      db.prisma,
      secrets,
      provider,
      realtime,
      () => clock,
    );
    supervisors.push(supervisor);
    return {
      session,
      provider,
      supervisor,
      realtime,
      advance: () => {
        clock = new Date(clock.getTime() + 1000);
      },
      emit: (event: BrokerEvent) => listener?.(event),
    };
  }
  it("lets only one supervisor own SDK sessions and serves durable requests without an LLM", async () => {
    const a = providerFixture();
    const b = providerFixture();
    const request = await readRequest();
    await Promise.all([a.supervisor.tick(), b.supervisor.tick()]);
    await Promise.all([a.supervisor.drain(), b.supervisor.drain()]);
    const calls =
      vi.mocked(a.provider.connect).mock.calls.length +
      vi.mocked(b.provider.connect).mock.calls.length;
    expect(calls).toBe(1);
    expect(
      (await db.prisma.brokerReadRequest.findUniqueOrThrow({ where: { id: request.id } })).result,
    ).toMatchObject({ balance: "10000" });
    expect(
      (await db.prisma.tradingConnection.findUniqueOrThrow({ where: { id: accountId } }))
        .environment,
    ).toBe("DEMO");
  });
  it("discovers account-scoped exact broker symbols and fulfills historical commands", async () => {
    const f = providerFixture();
    const request = await db.prisma.brokerReadRequest.create({
      data: {
        accountId,
        ownerUserId: owner,
        operation: "instruments",
        parameters: { accountId, operation: "instruments" },
        deadline: new Date(initialTime.getTime() + 120000),
      },
    });
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(
      (await db.prisma.brokerReadRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
    ).toBe("SUCCEEDED");
    const instruments = await db.prisma.brokerInstrument.findMany({ where: { accountId } });
    expect(instruments.map((instrument) => instrument.brokerSymbol).sort()).toEqual([
      "EURUSDm",
      "GOLD.a",
    ]);
    const id = instruments[0]?.id;
    if (!id) throw new Error("Missing instrument");
    const history = await db.prisma.brokerReadRequest.create({
      data: {
        accountId,
        ownerUserId: owner,
        operation: "candles",
        parameters: {
          accountId,
          operation: "candles",
          instrumentId: id,
          timeframe: "1h",
          limit: 50,
        },
        deadline: new Date(initialTime.getTime() + 120000),
      },
    });
    f.advance();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(
      (await db.prisma.brokerReadRequest.findUniqueOrThrow({ where: { id: history.id } })).result,
    ).toEqual([]);
  });
  it("coalesces chart/indicator history reads and expires current pages without storing quote history", async () => {
    const f = providerFixture();
    await f.supervisor.tick();
    await f.supervisor.drain();
    const instrument = await db.prisma.brokerInstrument.create({
      data: { accountId, brokerSymbol: "GOLD.a", displayName: "Gold" },
    });
    const request = () =>
      db.prisma.brokerReadRequest.create({
        data: {
          accountId,
          ownerUserId: owner,
          operation: "candles",
          parameters: {
            operation: "candles",
            accountId,
            instrumentId: instrument.id,
            timeframe: "1h",
            limit: 200,
          },
          deadline: new Date(initialTime.getTime() + 120000),
        },
      });
    const first = await request();
    const second = await request();
    f.advance();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(f.session.candles).toHaveBeenCalledTimes(1);
    const result = await db.prisma.brokerReadRequest.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(result.every((r) => r.status === "SUCCEEDED")).toBe(true);
    f.advance();
    f.advance();
    await request();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(f.session.candles).toHaveBeenCalledTimes(2);
    expect(f.provider.connect).toHaveBeenCalledTimes(1);
  });
  it("coalesces quotes and rejects duplicate/out-of-order updates without agent inference", async () => {
    const f = providerFixture();
    await f.supervisor.tick();
    await f.supervisor.drain();
    const observed: string[] = [];
    const unsubscribe = await f.realtime.subscribe(`broker:${accountId}`, (value) =>
      observed.push(value),
    );
    const quote = await f.session.quote("GOLD.a", "fixture-instrument");
    f.emit({ type: "quote", quote });
    f.emit({ type: "quote", quote });
    f.emit({
      type: "quote",
      quote: { ...quote, sourceTime: "2026-10-08T23:59:00.000Z", revision: "older" },
    });
    f.advance();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain("q1");
    f.emit({ type: "quote", quote });
    f.advance();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(observed).toHaveLength(1);
    expect(f.session.account).not.toHaveBeenCalled();
    await unsubscribe();
  });
  it("restores connected health after an internal provider reconnect", async () => {
    const f = providerFixture();
    await f.supervisor.tick();
    await f.supervisor.drain();
    f.emit({
      type: "connection_changed",
      accountId,
      connected: false,
      receivedAt: initialTime.toISOString(),
    });
    f.advance();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(
      (await db.prisma.brokerSessionLease.findUniqueOrThrow({ where: { accountId } })).state,
    ).toBe("RECONNECTING");
    f.emit({
      type: "connection_changed",
      accountId,
      connected: true,
      receivedAt: initialTime.toISOString(),
    });
    f.advance();
    await f.supervisor.tick();
    await f.supervisor.drain();
    expect(
      (await db.prisma.brokerSessionLease.findUniqueOrThrow({ where: { accountId } })).state,
    ).toBe("CONNECTED");
    expect(f.provider.connect).toHaveBeenCalledTimes(1);
  });
  it("cleans demand when realtime subscription setup fails", async () => {
    const instrument = await db.prisma.brokerInstrument.create({
      data: { accountId, brokerSymbol: "GOLD.a", displayName: "Gold" },
    });
    const realtime = new InMemoryRealtimeFanout();
    vi.spyOn(realtime, "subscribe").mockRejectedValue(new Error("fixture transport unavailable"));
    const stream = followBrokerData({
      prisma: db.prisma,
      realtime,
      ownerUserId: owner,
      accountId,
      instrumentIds: [instrument.id],
    });
    await expect(stream.next()).rejects.toThrow("fixture transport unavailable");
    expect(await db.prisma.brokerMarketSubscription.count()).toBe(0);
    await realtime.close();
  });
  it("authenticates streams, requires exact account instruments and cleans subscriptions", async () => {
    const now = new Date();
    const instrument = await db.prisma.brokerInstrument.create({
      data: { accountId, brokerSymbol: "GOLD.a", displayName: "Gold" },
    });
    await claimBrokerSession(db.prisma, accountId, "fixture-stream", now);
    const realtime = new InMemoryRealtimeFanout();
    const abort = new AbortController();
    const stream = followBrokerData({
      prisma: db.prisma,
      realtime,
      ownerUserId: owner,
      accountId,
      instrumentIds: [instrument.id],
      signal: abort.signal,
    });
    expect((await stream.next()).value).toMatchObject({ generation: 1, events: [] });
    expect(await db.prisma.brokerMarketSubscription.count()).toBe(1);
    const quote = BrokerQuoteSchema.parse({
      version: 1,
      provider: "metaapi",
      accountId,
      instrumentId: instrument.id,
      brokerSymbol: "GOLD.a",
      bid: "2700",
      ask: "2700.1",
      sourceTime: now.toISOString(),
      receivedAt: now.toISOString(),
      revision: "stream1",
    });
    const packet = stream.next();
    await realtime.publish(
      `broker:${accountId}`,
      JSON.stringify({ generation: 1, events: [{ type: "quote", quote }] }),
    );
    expect((await packet).value).toMatchObject({
      events: [{ type: "quote", quote: { revision: "stream1" } }],
    });
    abort.abort();
    await stream.return(undefined);
    expect(await db.prisma.brokerMarketSubscription.count()).toBe(0);
    const foreign = followBrokerData({
      prisma: db.prisma,
      realtime,
      ownerUserId: "foreign",
      accountId,
      instrumentIds: [],
    });
    await expect(foreign.next()).rejects.toThrow("Owner session required");
    const invalid = followBrokerData({
      prisma: db.prisma,
      realtime,
      ownerUserId: owner,
      accountId,
      instrumentIds: ["wrong-account-instrument"],
    });
    await expect(invalid.next()).rejects.toThrow("INVALID_REQUEST");
    await realtime.close();
  });
});
