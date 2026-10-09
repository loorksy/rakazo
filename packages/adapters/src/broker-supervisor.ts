import { randomUUID } from "node:crypto";
import type {
  BrokerEvent,
  BrokerProvider,
  BrokerReadSession,
  JobPublisher,
  RealtimeFanout,
  SecretStore,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { BrokerCandle, BrokerQuote, MarketCondition } from "@rakazo/contracts";
import {
  BrokerQuoteSchema,
  BrokerReadCommandSchema,
  MarketConditionSchema,
} from "@rakazo/contracts";
import { observeMarketCondition } from "@rakazo/core";
import type { BrokerLeaseToken, PrismaClient } from "@rakazo/db";
import {
  claimBrokerSession,
  heartbeatBrokerSession,
  Prisma,
  releaseBrokerSession,
  StaleBrokerSessionError,
  withBrokerSessionFence,
} from "@rakazo/db";
import { z } from "zod";
import { observeMarketWatches, recoverMarketWakes } from "./market-watches.js";
import { BrokerProviderError, sanitizedBrokerError } from "./metaapi-normalize.js";

interface Slot {
  token: BrokerLeaseToken;
  session?: BrokerReadSession;
  running: boolean;
  lastHeartbeat: number;
  retryAt: number;
  failures: number;
  release?: () => Promise<void>;
  demands: Map<string, { symbol: string; expires: number }>;
  observed: string;
  pending: Map<string, BrokerEvent>;
  flushing: boolean;
  readAt: number;
  quoteTimes: Map<string, { time: string; revision: string }>;
  abort: AbortController;
  conditions: Map<
    string,
    {
      instrumentId: string;
      condition: MarketCondition;
      previousValue: string | null;
      previousSourceTime: string | null;
    }
  >;
  crossings: Map<
    string,
    {
      id: string;
      quote: BrokerQuote;
      previousValue: string | null;
      previousSourceTime: string | null;
    }
  >;
  history: Map<string, { expires: number; candles: BrokerCandle[] }>;
}

/** Account socket lifecycle inside the existing Worker; not an agent runtime or job scheduler. */
export class BrokerConnectionSupervisor {
  private readonly holder = `broker-worker:${randomUUID()}`;
  private readonly slots = new Map<string, Slot>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private readonly work = new Set<Promise<void>>();
  private lastCleanup = 0;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly provider: BrokerProvider,
    private readonly realtime?: RealtimeFanout,
    private readonly now: () => Date = () => new Date(),
    private readonly jobs?: JobPublisher,
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.track(this.tick());
    }, 250);
    this.timer.unref();
    this.track(this.tick());
  }
  private track(work: Promise<void>) {
    this.work.add(work);
    void work.catch(() => undefined).finally(() => this.work.delete(work));
  }
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (this.now().getTime() - this.lastCleanup >= 60000) {
        await this.prisma.brokerMarketSubscription.deleteMany({
          where: { expiresAt: { lt: this.now() } },
        });
        await this.prisma.brokerReadRequest.deleteMany({
          where: { deadline: { lt: new Date(this.now().getTime() - 86400000) } },
        });
        this.lastCleanup = this.now().getTime();
      }
      const owner = await this.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { ownerUserId: true, ownerBootstrapCompleted: true },
      });
      const connections =
        owner?.ownerUserId && owner.ownerBootstrapCompleted
          ? await this.prisma.tradingConnection.findMany({
              where: { revokedAt: null, provider: "metaapi", ownerUserId: owner.ownerUserId },
              take: 32,
              orderBy: { createdAt: "asc" },
            })
          : [];
      const active = new Set(connections.map((row) => row.id));
      for (const [id, slot] of this.slots) if (!active.has(id)) await this.drop(id, slot);
      for (const row of connections) {
        let slot = this.slots.get(row.id);
        try {
          if (slot && slot.token.credentialVersion !== row.credentialVersion) {
            await this.drop(row.id, slot);
            slot = undefined;
          }
          if (!slot) {
            const token = await claimBrokerSession(this.prisma, row.id, this.holder, this.now());
            if (!token) continue;
            slot = {
              token,
              running: false,
              lastHeartbeat: this.now().getTime(),
              retryAt: 0,
              failures: 0,
              demands: new Map(),
              observed: "",
              pending: new Map(),
              flushing: false,
              readAt: 0,
              quoteTimes: new Map(),
              abort: new AbortController(),
              history: new Map(),
              conditions: new Map(),
              crossings: new Map(),
            };
            this.slots.set(row.id, slot);
          }
          if (this.now().getTime() - slot.lastHeartbeat >= 5000) {
            await heartbeatBrokerSession(this.prisma, slot.token, this.now());
            slot.lastHeartbeat = this.now().getTime();
          }
          if (!slot.flushing && (slot.pending.size || slot.crossings.size)) {
            const current = slot;
            current.flushing = true;
            this.track(
              this.flush(current)
                .catch(async () => {
                  await this.drop(row.id, current);
                })
                .finally(() => {
                  current.flushing = false;
                }),
            );
          }
          if (!slot.running && this.now().getTime() >= Math.max(slot.retryAt, slot.readAt)) {
            const current = slot;
            current.running = true;
            current.readAt = this.now().getTime() + 1000;
            this.track(
              this.run(
                current,
                row.ciphertext,
                row.providerAccountId,
                row.region ?? undefined,
              ).finally(() => {
                current.running = false;
              }),
            );
          }
        } catch {
          if (slot) await this.drop(row.id, slot);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private async run(
    slot: Slot,
    ciphertext: string,
    providerAccountId: string,
    region?: string,
  ): Promise<void> {
    const token = slot.token;
    try {
      if (!slot.session) {
        const session = await this.provider.connect({
          accountId: token.accountId,
          providerAccountId,
          region,
          resolveCredential: () => this.secrets.load(ciphertext, token.accountId),
          signal: slot.abort.signal,
        });
        // A revoked/taken-over slot cannot keep a socket opened while connect was in flight.
        if (this.slots.get(token.accountId) !== slot || this.stopping) {
          await session.close();
          return;
        }
        slot.session = session;
        const capabilities = await session.capabilities();
        await withBrokerSessionFence(
          this.prisma,
          token,
          async (tx) => {
            await tx.tradingConnection.update({
              where: { id: token.accountId },
              data: { capabilities, environment: capabilities.environment, verifiedAt: this.now() },
            });
            await tx.brokerSessionLease.update({
              where: { accountId: token.accountId },
              data: { state: "CONNECTED", lastHealthyAt: this.now(), failureCode: null },
            });
          },
          this.now(),
        );
        slot.failures = 0;
        slot.release = await session.subscribe([], (event) => this.observe(slot, event));
      }
      const requests = await this.prisma.brokerReadRequest.findMany({
        where: { accountId: token.accountId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: 8,
      });
      for (const request of requests) {
        const claimed = await withBrokerSessionFence(
          this.prisma,
          token,
          (tx) =>
            tx.brokerReadRequest.updateMany({
              where: { id: request.id, status: "PENDING" },
              data: { status: "STARTED", claimedGeneration: token.generation },
            }),
          this.now(),
        );
        if (!claimed.count) continue;
        try {
          if (request.deadline <= this.now()) throw new BrokerProviderError("UNAVAILABLE");
          const command = BrokerReadCommandSchema.parse(request.parameters);
          const connection = await this.prisma.tradingConnection.findUniqueOrThrow({
            where: { id: token.accountId },
            select: { ownerUserId: true },
          });
          if (
            command.accountId !== token.accountId ||
            command.operation !== request.operation ||
            request.ownerUserId !== connection.ownerUserId
          )
            throw new BrokerProviderError("INVALID_REQUEST");
          const result = await this.executeRead(slot, command);
          await withBrokerSessionFence(
            this.prisma,
            token,
            async (tx) => {
              await tx.brokerReadRequest.updateMany({
                where: { id: request.id, status: "STARTED", claimedGeneration: token.generation },
                data: { status: "SUCCEEDED", result: result === null ? Prisma.JsonNull : result },
              });
              await tx.brokerSessionLease.update({
                where: { accountId: token.accountId },
                data: { lastHealthyAt: this.now() },
              });
            },
            this.now(),
          );
        } catch (error) {
          if (error instanceof StaleBrokerSessionError) throw error;
          await withBrokerSessionFence(
            this.prisma,
            token,
            (tx) =>
              tx.brokerReadRequest.updateMany({
                where: { id: request.id, status: "STARTED", claimedGeneration: token.generation },
                data: { status: "FAILED", failureCode: sanitizedBrokerError(error).code },
              }),
            this.now(),
          );
          if (sanitizedBrokerError(error).code === "RATE_LIMITED") {
            slot.retryAt = this.now().getTime() + 5000;
            break;
          }
        }
      }
      const recovered = await withBrokerSessionFence(
        this.prisma,
        token,
        async (tx) => {
          await tx.marketWatch.updateMany({
            where: { accountId: token.accountId, status: "ACTIVE", expiresAt: { lte: this.now() } },
            data: { status: "EXPIRED", revision: { increment: 1 } },
          });
          return recoverMarketWakes(tx, token.accountId);
        },
        this.now(),
      );
      for (const runId of recovered)
        await this.jobs?.enqueue(runContinueJob(runId)).catch(() => undefined);
      await this.updateSubscriptions(slot);
    } catch (error) {
      await slot.release?.().catch(() => undefined);
      slot.release = undefined;
      await slot.session?.close().catch(() => undefined);
      slot.session = undefined;
      slot.history.clear();
      slot.observed = "";
      if (error instanceof StaleBrokerSessionError) {
        await this.drop(token.accountId, slot);
        return;
      }
      if (this.stopping) return;
      slot.failures++;
      slot.retryAt = this.now().getTime() + Math.min(60000, 1000 * 2 ** Math.min(slot.failures, 6));
      await withBrokerSessionFence(
        this.prisma,
        token,
        (tx) =>
          tx.brokerSessionLease.update({
            where: { accountId: token.accountId },
            data: {
              state: "RECONNECTING",
              failureCode: sanitizedBrokerError(error).code,
              reconnectCount: { increment: 1 },
            },
          }),
        this.now(),
      ).catch(() => undefined);
    }
  }
  private async executeRead(slot: Slot, command: z.infer<typeof BrokerReadCommandSchema>) {
    const session = slot.session;
    if (!session) throw new BrokerProviderError("DISCONNECTED");
    if (command.operation === "account") return z.json().parse(await session.account());
    if (command.operation === "positions") return z.json().parse(await session.positions());
    if (command.operation === "orders") return z.json().parse(await session.orders());
    if (command.operation === "capabilities") return z.json().parse(await session.capabilities());
    if (command.operation === "instruments") {
      const symbols = await session.symbols();
      const result: Array<{
        id: string;
        accountId: string;
        brokerSymbol: string;
        displayName: string;
        verifiedAt: string | null;
      }> = [];
      // Bound each transaction: large broker directories must not hold a lock beyond a lease lifetime.
      for (let offset = 0; offset < symbols.length; offset += 100) {
        const rows = await withBrokerSessionFence(
          this.prisma,
          slot.token,
          async (tx) => {
            const batch = [];
            for (const symbol of symbols.slice(offset, offset + 100))
              batch.push(
                await tx.brokerInstrument.upsert({
                  where: {
                    accountId_brokerSymbol: { accountId: command.accountId, brokerSymbol: symbol },
                  },
                  create: {
                    accountId: command.accountId,
                    brokerSymbol: symbol,
                    displayName: symbol,
                  },
                  update: { active: true },
                  select: {
                    id: true,
                    accountId: true,
                    brokerSymbol: true,
                    displayName: true,
                    verifiedAt: true,
                  },
                }),
              );
            return batch;
          },
          this.now(),
        );
        result.push(
          ...rows.map((instrument) => ({
            ...instrument,
            verifiedAt: instrument.verifiedAt?.toISOString() ?? null,
          })),
        );
      }
      await withBrokerSessionFence(
        this.prisma,
        slot.token,
        (tx) =>
          tx.brokerInstrument.updateMany({
            where: { accountId: command.accountId, brokerSymbol: { notIn: symbols } },
            data: { active: false },
          }),
        this.now(),
      );
      return z.json().parse(result);
    }
    const instrument = await this.prisma.brokerInstrument.findFirst({
      where: { id: command.instrumentId, accountId: command.accountId, active: true },
    });
    if (!instrument) throw new BrokerProviderError("INVALID_REQUEST");
    if (command.operation === "specification") {
      const specification = await session.specification(instrument.brokerSymbol);
      await withBrokerSessionFence(
        this.prisma,
        slot.token,
        (tx) =>
          tx.brokerInstrument.update({
            where: { id: instrument.id },
            data: {
              specification: z.record(z.string(), z.json()).parse(specification),
              verifiedAt: this.now(),
              revision: { increment: 1 },
            },
          }),
        this.now(),
      );
      return z.json().parse(specification);
    }
    if (command.operation === "quote") {
      slot.demands.set(instrument.id, {
        symbol: instrument.brokerSymbol,
        expires: this.now().getTime() + 60000,
      });
      return z.json().parse(await session.quote(instrument.brokerSymbol, instrument.id));
    }
    const key = JSON.stringify([
      instrument.id,
      command.timeframe,
      command.before ?? null,
      command.limit,
    ]);
    const cached = slot.history.get(key);
    if (cached && cached.expires > this.now().getTime()) return z.json().parse(cached.candles);
    const candles = await session.candles({
      symbol: instrument.brokerSymbol,
      instrumentId: instrument.id,
      timeframe: command.timeframe,
      before: command.before,
      limit: command.limit,
    });
    // Shared by observers, indicators and visual inspection in this account's fenced session.
    // Historical pages are rebuildable; live pages expire rapidly and never authorize execution.
    slot.history.delete(key);
    while (slot.history.size >= 16) {
      const oldest = slot.history.keys().next().value;
      if (oldest === undefined) break;
      slot.history.delete(oldest);
    }
    slot.history.set(key, {
      expires: this.now().getTime() + (command.before ? 30000 : 2000),
      candles,
    });
    return z.json().parse(candles);
  }
  private observe(slot: Slot, event: BrokerEvent) {
    if (this.stopping || this.slots.get(slot.token.accountId) !== slot) return;
    if (event.type === "quote") {
      if (
        event.quote.accountId !== slot.token.accountId ||
        !BrokerQuoteSchema.safeParse(event.quote).success
      )
        return;
    } else if (event.accountId !== slot.token.accountId) return;
    if (event.type === "quote")
      for (const [id, condition] of slot.conditions) {
        if (condition.instrumentId !== event.quote.instrumentId || slot.crossings.has(id)) continue;
        const result = observeMarketCondition({
          condition: condition.condition,
          quote: event.quote,
          now: this.now(),
          previousValue: condition.previousValue,
          previousSourceTime: condition.previousSourceTime,
        });
        if (!result.observed) continue;
        if (result.fire)
          slot.crossings.set(id, {
            id,
            quote: event.quote,
            previousValue: condition.previousValue,
            previousSourceTime: condition.previousSourceTime,
          });
        condition.previousValue = result.value;
        condition.previousSourceTime = event.quote.sourceTime;
      }
    const key =
      event.type === "quote"
        ? `quote:${event.quote.instrumentId}`
        : event.type === "account_changed"
          ? `account:${event.kind}`
          : "connection";
    if (slot.pending.size < 512 || slot.pending.has(key)) {
      const previous = slot.pending.get(key);
      if (
        event.type === "quote" &&
        previous?.type === "quote" &&
        Date.parse(previous.quote.sourceTime) >= Date.parse(event.quote.sourceTime)
      )
        return;
      if (event.type === "quote") {
        const last = slot.quoteTimes.get(event.quote.instrumentId);
        if (
          last &&
          (Date.parse(last.time) > Date.parse(event.quote.sourceTime) ||
            last.revision === event.quote.revision)
        )
          return;
        if (slot.quoteTimes.size < 256 || slot.quoteTimes.has(event.quote.instrumentId))
          slot.quoteTimes.set(event.quote.instrumentId, {
            time: event.quote.sourceTime,
            revision: event.quote.revision,
          });
      }
      slot.pending.set(key, event);
    }
  }
  private async flush(slot: Slot) {
    if (!slot.pending.size && !slot.crossings.size) return;
    const crossings = [...slot.crossings.values()].slice(0, 20);
    for (const crossing of crossings) slot.crossings.delete(crossing.id);
    const events = [...slot.pending.values()];
    slot.pending.clear();
    const connectionEvent = events.find((event) => event.type === "connection_changed");
    const wakeRuns = await withBrokerSessionFence(
      this.prisma,
      slot.token,
      async (tx) => {
        const runs: string[] = [];
        // Capture useful conditions before visual quote coalescing can hide a short excursion.
        for (const crossing of crossings)
          runs.push(...(await observeMarketWatches(tx, crossing.quote, this.now(), crossing)));
        // Unsatisfied stream observations stay in bounded memory. Only captured logical
        // conditions enter PostgreSQL; batch limits prevent mass triggers starving leases.
        await tx.brokerSessionLease.update({
          where: { accountId: slot.token.accountId },
          data: {
            lastEventAt: this.now(),
            ...(connectionEvent?.type === "connection_changed"
              ? { state: connectionEvent.connected ? "CONNECTED" : "RECONNECTING" }
              : {}),
            ...(connectionEvent?.type === "connection_changed" && connectionEvent.connected
              ? { lastHealthyAt: this.now(), failureCode: null }
              : {}),
          },
        });
        return runs;
      },
      this.now(),
    );
    for (const runId of wakeRuns)
      await this.jobs?.enqueue(runContinueJob(runId)).catch(() => undefined);
    if (this.realtime)
      for (let offset = 0; offset < events.length; offset += 4) {
        // Small bounded batches stay beneath PostgreSQL's NOTIFY payload limit.
        await this.realtime.publish(
          `broker:${slot.token.accountId}`,
          JSON.stringify({
            generation: slot.token.generation,
            events: events.slice(offset, offset + 4),
          }),
        );
      }
  }
  private async updateSubscriptions(slot: Slot) {
    if (!slot.session) return;
    const watches = await this.prisma.marketWatch.findMany({
      where: { accountId: slot.token.accountId, status: "ACTIVE", expiresAt: { gt: this.now() } },
      select: {
        id: true,
        condition: true,
        lastValue: true,
        lastSourceTime: true,
        instrumentId: true,
        expiresAt: true,
      },
      take: 1000,
    });
    const activeWatches = new Set(watches.map((w) => w.id));
    for (const id of slot.conditions.keys()) if (!activeWatches.has(id)) slot.conditions.delete(id);
    for (const watch of watches)
      if (!slot.conditions.has(watch.id))
        slot.conditions.set(watch.id, {
          instrumentId: watch.instrumentId,
          condition: MarketConditionSchema.parse(watch.condition),
          previousValue: watch.lastValue,
          previousSourceTime: watch.lastSourceTime?.toISOString() ?? null,
        });
    const subscriptions = [
      ...watches,
      ...(await this.prisma.brokerMarketSubscription.findMany({
        where: { accountId: slot.token.accountId, expiresAt: { gt: this.now() } },
        select: { instrumentId: true, expiresAt: true },
        take: 1024,
      })),
    ];
    const instruments = await this.prisma.brokerInstrument.findMany({
      where: {
        accountId: slot.token.accountId,
        active: true,
        id: { in: [...new Set(subscriptions.map((entry) => entry.instrumentId))] },
      },
      take: 256,
    });
    for (const instrument of instruments) {
      const expiry = Math.max(
        ...subscriptions
          .filter((entry) => entry.instrumentId === instrument.id)
          .map((entry) => entry.expiresAt.getTime()),
      );
      const existing = slot.demands.get(instrument.id);
      slot.demands.set(instrument.id, {
        symbol: instrument.brokerSymbol,
        expires: Math.max(existing?.expires ?? 0, expiry),
      });
    }
    for (const [id, demand] of slot.demands)
      if (demand.expires <= this.now().getTime()) slot.demands.delete(id);
    const key = [...slot.demands.keys()].sort().join("\n");
    if (key === slot.observed) return;
    const release = await slot.session.subscribe(
      [...slot.demands]
        .slice(0, 256)
        .map(([instrumentId, entry]) => ({ instrumentId, symbol: entry.symbol })),
      (event) => this.observe(slot, event),
    );
    await slot.release?.();
    slot.release = release;
    slot.observed = key;
  }
  private async drop(id: string, slot: Slot) {
    if (this.slots.get(id) === slot) this.slots.delete(id);
    slot.abort.abort();
    await slot.release?.().catch(() => undefined);
    await slot.session?.close().catch(() => undefined);
    await releaseBrokerSession(this.prisma, slot.token, this.now()).catch(() => undefined);
  }
  /** Useful for deterministic integration tests and graceful shutdown without sockets surviving. */
  async drain() {
    await Promise.allSettled([...this.work]);
  }
  async close() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    for (const [id, slot] of this.slots) await this.drop(id, slot);
    await this.drain();
  }
}
