import type { ArtifactStore } from "@rakazo/adapter-kit";
import { CloudChartSchema, CustomIndicatorSchema } from "@rakazo/contracts";
import { claimBrokerSession, createDb, withBrokerSessionFence } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { followChartEvents } from "./chart-events.js";
import { ChartIndicators } from "./chart-indicators.js";
import type { ChartActor } from "./cloud-charts.js";
import { CloudCharts, guardChartProjection } from "./cloud-charts.js";
import { MarketWatches, observeMarketWatches, recoverMarketWakes } from "./market-watches.js";
import { InMemoryRealtimeFanout } from "./realtime.js";

const url = process.env.CHART_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("durable chart workspace (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const owner = "fixture-owner";
  const principal = { ownerUserId: owner };
  let accountId: string;
  let instrumentId: string;
  let otherInstrumentId: string;
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE market_watches, chart_indicator_definitions, cloud_charts, trading_connections, organization, deployment_settings CASCADE`;
  beforeAll(() => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("Dedicated _test database required");
    db = createDb(url);
  });
  beforeEach(async () => {
    await reset();
    await db.prisma.deploymentSettings.create({
      data: {
        id: "default",
        ownerUserId: owner,
        ownerSpaceId: "fixture-space",
        singleOwnerEnforced: true,
        ownerBootstrapCompleted: true,
      },
    });
    await db.prisma.organization.create({
      data: { id: "fixture-org", slug: "fixture-org", name: "Fixture", createdAt: new Date() },
    });
    await db.prisma.space.create({
      data: { id: "fixture-space", organizationId: "fixture-org", name: "Fixture" },
    });
    const account = await db.prisma.tradingConnection.create({
      data: {
        ownerUserId: owner,
        label: "Fixture",
        providerAccountId: "remote",
        ciphertext: "fixture-only-ref",
      },
    });
    accountId = account.id;
    const instrument = await db.prisma.brokerInstrument.create({
      data: { accountId, brokerSymbol: "GOLD.a", displayName: "Gold" },
    });
    instrumentId = instrument.id;
    otherInstrumentId = (
      await db.prisma.brokerInstrument.create({
        data: { accountId, brokerSymbol: "EURUSDm", displayName: "Euro" },
      })
    ).id;
  });
  afterAll(async () => {
    if (db) {
      await reset();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function create(
    scope: "MAIN" | "SHARED" | "WORKER" = "MAIN",
    actor: ChartActor = principal,
  ) {
    return CloudChartSchema.parse(
      await new CloudCharts(db.prisma).command(actor, {
        operation: "create",
        accountId,
        instrumentId,
        timeframe: "1h",
        scope,
      }),
    );
  }
  async function worker(id = "fixture-main", main = true) {
    await db.prisma.bot.create({
      data: {
        id,
        spaceId: "fixture-space",
        userId: owner,
        name: "Fixture",
        color: "blue",
        spawnKey: main ? "trading:main:v1" : null,
      },
    });
    const thread = await db.prisma.thread.create({
      data: { spaceId: "fixture-space", botId: id, userId: owner },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: "fixture-space",
        botId: id,
        userId: owner,
        threadId: thread.id,
        prompt: "Fixture",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: "fixture-space",
        botId: id,
        threadId: thread.id,
        userId: owner,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "a",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    return {
      ownerUserId: owner,
      botId: id,
      execution: { runId: run.id, holder: "a", generation: 1 },
    };
  }
  it("rejects stale rendered artifacts after takeover or chart revision change", async () => {
    const actor = await worker();
    const chart = await create("MAIN", actor);
    await expect(
      db.prisma.$transaction((tx) => guardChartProjection(tx, actor, chart.id, chart.revision)),
    ).resolves.toBeUndefined();
    await new CloudCharts(db.prisma).command(principal, {
      operation: "zoom",
      chartId: chart.id,
      expectedRevision: chart.revision,
      factor: 2,
    });
    await expect(
      db.prisma.$transaction((tx) => guardChartProjection(tx, actor, chart.id, chart.revision)),
    ).rejects.toThrow("Chart changed");
    await db.prisma.run.update({
      where: { id: actor.execution.runId },
      data: { leaseOwner: "b", leaseFence: 2 },
    });
    const current = CloudChartSchema.parse(
      await new CloudCharts(db.prisma).command(principal, { operation: "get", chartId: chart.id }),
    );
    await expect(
      db.prisma.$transaction((tx) => guardChartProjection(tx, actor, chart.id, current.revision)),
    ).rejects.toThrow();
    const newer = { ...actor, execution: { ...actor.execution, holder: "b", generation: 2 } };
    await expect(
      db.prisma.$transaction((tx) => guardChartProjection(tx, newer, chart.id, current.revision)),
    ).resolves.toBeUndefined();
  });
  async function watchFixture() {
    const actor = await worker();
    const now = new Date("2026-10-09T12:00:00Z");
    const service = new MarketWatches(db.prisma, () => now);
    const watch = await service.command(
      actor,
      {
        operation: "create",
        accountId,
        instrumentId,
        condition: { version: 1, field: "BID", comparison: "AT_OR_ABOVE", price: "2700" },
        expiresAt: "2026-10-10T12:00:00Z",
        summary: "Report price threshold",
      },
      "fixture-call",
    );
    if (Array.isArray(watch)) throw new Error("Fixture record");
    const token = await claimBrokerSession(db.prisma, accountId, "fixture-market", now);
    if (!token) throw new Error("Fixture broker ownership");
    const quote = {
      version: 1 as const,
      provider: "metaapi",
      accountId,
      instrumentId,
      brokerSymbol: "GOLD.a",
      bid: "2700.1",
      ask: "2700.2",
      sourceTime: now.toISOString(),
      receivedAt: now.toISOString(),
      revision: "q1",
    };
    const observe = () =>
      withBrokerSessionFence(db.prisma, token, (tx) => observeMarketWatches(tx, quote, now), now);
    const recover = () =>
      withBrokerSessionFence(db.prisma, token, (tx) => recoverMarketWakes(tx, accountId), now);
    return { actor, now, service, watch, quote, token, observe, recover };
  }
  it("durably fires concurrent duplicate market events into exactly one existing turn", async () => {
    const f = await watchFixture();
    const before = await db.prisma.run.count();
    const [first, second] = await Promise.all([f.observe(), f.observe()]);
    expect(first.length + second.length).toBe(1);
    expect(await db.prisma.run.count()).toBe(before + 1);
    const saved = await db.prisma.marketWatch.findUniqueOrThrow({ where: { id: f.watch.id } });
    expect(saved).toMatchObject({ status: "FIRED", wakeGeneration: 1 });
    expect(await f.recover()).toEqual([]);
    expect(await f.observe()).toEqual([]);
    const wake = await db.prisma.run.findUniqueOrThrow({
      where: { id: saved.triggeredRunId ?? "" },
    });
    expect(wake).toMatchObject({
      trigger: "routine",
      clientNonce: `market-watch:${saved.id}:1`,
      status: "queued",
    });
  });
  it("retains captured work when its conversation is deleted and relinks once", async () => {
    const f = await watchFixture();
    const [first] = await f.observe();
    if (!first) throw new Error("Fixture wake");
    const old = await db.prisma.run.findUniqueOrThrow({ where: { id: first } });
    await db.prisma.thread.delete({ where: { id: old.threadId } });
    expect(await db.prisma.marketWatch.findUnique({ where: { id: f.watch.id } })).toMatchObject({
      status: "DELIVERY_NEEDED",
      wakeGeneration: 1,
      triggeredRunId: null,
    });
    const restored = await f.recover();
    expect(restored).toHaveLength(1);
    expect(restored[0]).not.toBe(first);
    expect(await f.recover()).toEqual([]);
    expect(
      (await db.prisma.marketWatch.findUniqueOrThrow({ where: { id: f.watch.id } })).wakeGeneration,
    ).toBe(1);
  });
  it("records completion atomically and never replays fulfilled work after session deletion", async () => {
    const f = await watchFixture();
    const [id] = await f.observe();
    if (!id) throw new Error("Fixture wake");
    const run = await db.prisma.run.update({
      where: { id },
      data: { status: "completed", completedAt: f.now },
    });
    expect(await db.prisma.marketWatch.findUnique({ where: { id: f.watch.id } })).toMatchObject({
      wakeCompletedAt: f.now,
      status: "FIRED",
    });
    await db.prisma.thread.delete({ where: { id: run.threadId } });
    expect(await f.recover()).toEqual([]);
    expect(await f.observe()).toEqual([]);
  });
  it("keeps failed/cancelled observation work explicit instead of repeatedly polling a model", async () => {
    const f = await watchFixture();
    const [id] = await f.observe();
    if (!id) throw new Error("Fixture wake");
    await db.prisma.run.update({ where: { id }, data: { status: "failed", completedAt: f.now } });
    const list = await f.service.command(principal, { operation: "list" });
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.watch.id, status: "NEEDS_ATTENTION" }),
      ]),
    );
    expect(await f.recover()).toEqual([]);
  });
  it("deduplicates watch creation and rejects stale worker edits even after rereading", async () => {
    const f = await watchFixture();
    const create = {
      operation: "create",
      accountId,
      instrumentId,
      condition: { version: 1, field: "BID", comparison: "AT_OR_ABOVE", price: "2700" },
      expiresAt: "2026-10-10T12:00:00Z",
      summary: "Report price threshold",
    };
    expect(await f.service.command(f.actor, create, "fixture-call")).toMatchObject({
      id: f.watch.id,
    });
    await expect(
      f.service.command(f.actor, { ...create, summary: "Changed payload" }, "fixture-call"),
    ).rejects.toThrow("identity changed");
    await db.prisma.run.update({
      where: { id: f.actor.execution.runId },
      data: { leaseFence: 2, leaseOwner: "newer" },
    });
    const current = await db.prisma.marketWatch.findUniqueOrThrow({ where: { id: f.watch.id } });
    await expect(
      f.service.command(f.actor, {
        operation: "cancel",
        id: f.watch.id,
        expectedRevision: current.revision,
      }),
    ).rejects.toThrow();
    await expect(f.service.command(f.actor, create, "new-call")).rejects.toThrow();
  });
  it("does no model work for stale/unsatisfied quotes, and expires without creating a turn", async () => {
    const f = await watchFixture();
    const count = await db.prisma.run.count();
    const below = { ...f.quote, bid: "2699", ask: "2699.1" };
    expect(
      await withBrokerSessionFence(
        db.prisma,
        f.token,
        (tx) => observeMarketWatches(tx, below, f.now),
        f.now,
      ),
    ).toEqual([]);
    const expired = new Date(f.now.getTime() + 2 * 86400000);
    await db.prisma.$transaction((tx) => observeMarketWatches(tx, f.quote, expired));
    expect(await db.prisma.run.count()).toBe(count);
    expect(await db.prisma.marketWatch.findUnique({ where: { id: f.watch.id } })).toMatchObject({
      status: "EXPIRED",
      wakeGeneration: 0,
    });
  });
  it("preserves a witnessed intrabatch crossing even when the visible quote coalesces back below", async () => {
    const f = await watchFixture();
    await db.prisma.marketWatch.update({
      where: { id: f.watch.id },
      data: {
        condition: { version: 1, field: "BID", comparison: "CROSS_ABOVE", price: "2700" },
        lastValue: null,
      },
    });
    const other = await f.service.command(
      f.actor,
      {
        operation: "create",
        accountId,
        instrumentId,
        condition: { version: 1, field: "BID", comparison: "CROSS_BELOW", price: "2700" },
        expiresAt: "2026-10-10T12:00:00Z",
        summary: "Other direction",
      },
      "other-call",
    );
    const runs = await withBrokerSessionFence(
      db.prisma,
      f.token,
      (tx) =>
        observeMarketWatches(tx, f.quote, f.now, {
          id: f.watch.id,
          previousValue: "2699",
          previousSourceTime: new Date(f.now.getTime() - 1000).toISOString(),
        }),
      f.now,
    );
    expect(runs).toHaveLength(1);
    if (Array.isArray(other)) throw new Error("Fixture");
    expect(await db.prisma.marketWatch.findUnique({ where: { id: other.id } })).toMatchObject({
      status: "ACTIVE",
      lastValue: null,
      wakeGeneration: 0,
    });
    const below = {
      ...f.quote,
      bid: "2699",
      ask: "2699.1",
      sourceTime: new Date(f.now.getTime() + 1).toISOString(),
      revision: "q2",
    };
    expect(
      await withBrokerSessionFence(
        db.prisma,
        f.token,
        (tx) => observeMarketWatches(tx, below, f.now),
        f.now,
      ),
    ).toEqual([]);
    expect(
      (await db.prisma.marketWatch.findUniqueOrThrow({ where: { id: f.watch.id } })).wakeGeneration,
    ).toBe(1);
  });
  it("keeps repeated unsatisfied price quotes ephemeral instead of growing durable telemetry", async () => {
    const f = await watchFixture();
    const below = { ...f.quote, bid: "2699", ask: "2699.1" };
    await withBrokerSessionFence(
      db.prisma,
      f.token,
      (tx) => observeMarketWatches(tx, below, f.now),
      f.now,
    );
    const first = await db.prisma.marketWatch.findUniqueOrThrow({ where: { id: f.watch.id } });
    const next = {
      ...below,
      bid: "2698",
      sourceTime: new Date(f.now.getTime() + 1).toISOString(),
      revision: "q2",
    };
    await withBrokerSessionFence(
      db.prisma,
      f.token,
      (tx) => observeMarketWatches(tx, next, f.now),
      f.now,
    );
    expect(
      (await db.prisma.marketWatch.findUniqueOrThrow({ where: { id: f.watch.id } })).revision,
    ).toBe(first.revision);
  });
  it("captures delivery-needed state if the responsible Bot disappears without transferring authority", async () => {
    const f = await watchFixture();
    await db.prisma.bot.delete({ where: { id: f.actor.botId } });
    await f.observe();
    expect(await db.prisma.marketWatch.findUnique({ where: { id: f.watch.id } })).toMatchObject({
      status: "DELIVERY_NEEDED",
      wakeGeneration: 1,
    });
    expect(await f.recover()).toEqual([]);
  });
  const drawing = {
    type: "horizontalStraightLine",
    points: [{ time: "2026-10-09T00:00:00Z", price: "2700.123456789123" }],
    text: "Support",
    visible: true,
    locked: false,
    evidenceRefs: [],
  };
  it("restores backend state and exact instrument after a new DB client and survives thread deletion", async () => {
    const actor = await worker();
    const chart = await create("MAIN", actor);
    const edited = CloudChartSchema.parse(
      await new CloudCharts(db.prisma).command(actor, {
        operation: "drawing_create",
        chartId: chart.id,
        expectedRevision: chart.revision,
        drawing,
      }),
    );
    const fresh = createDb(url!);
    try {
      expect(
        await new CloudCharts(fresh.prisma).command(principal, {
          operation: "get",
          chartId: chart.id,
        }),
      ).toEqual(edited);
    } finally {
      await fresh.prisma.$disconnect();
      await fresh.pool.end();
    }
    await db.prisma.thread.deleteMany();
    expect(
      await new CloudCharts(db.prisma).command(principal, { operation: "get", chartId: chart.id }),
    ).toEqual(edited);
  });
  it("rejects stale chart revisions without overwriting newer changes", async () => {
    const chart = await create();
    const service = new CloudCharts(db.prisma);
    const outcomes = await Promise.allSettled([
      service.command(principal, {
        operation: "set_timeframe",
        chartId: chart.id,
        expectedRevision: 1,
        timeframe: "4h",
      }),
      service.command(principal, {
        operation: "set_timeframe",
        chartId: chart.id,
        expectedRevision: 1,
        timeframe: "1d",
      }),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(
      (await db.prisma.cloudChart.findUniqueOrThrow({ where: { id: chart.id } })).revision,
    ).toBe(2);
  });
  it("requires the original run generation for every worker write even after rereading current state", async () => {
    const actor = await worker();
    const chart = await create("MAIN", actor);
    await db.prisma.run.update({
      where: { id: actor.execution.runId },
      data: { leaseOwner: "b", leaseFence: 2 },
    });
    await new CloudCharts(db.prisma).command(actor, { operation: "get", chartId: chart.id });
    await expect(
      new CloudCharts(db.prisma).command(actor, {
        operation: "zoom",
        chartId: chart.id,
        expectedRevision: chart.revision,
        factor: 2,
      }),
    ).rejects.toThrow("not editable");
    expect(
      (await db.prisma.cloudChart.findUniqueOrThrow({ where: { id: chart.id } })).revision,
    ).toBe(1);
  });
  it("protects user drawings and independent object revisions during simultaneous edits", async () => {
    const actor = await worker();
    const chart = await create();
    const service = new CloudCharts(db.prisma);
    const edited = CloudChartSchema.parse(
      await service.command(principal, {
        operation: "drawing_create",
        chartId: chart.id,
        expectedRevision: 1,
        drawing,
      }),
    );
    const drawingId = edited.state.drawings[0]!.id;
    await expect(
      service.command(actor, {
        operation: "drawing_update",
        chartId: chart.id,
        drawingId,
        expectedDrawingRevision: 1,
        drawing: { ...drawing, text: "Bot override" },
      }),
    ).rejects.toThrow("not editable");
    await service.command(principal, {
      operation: "drawing_update",
      chartId: chart.id,
      drawingId,
      expectedDrawingRevision: 1,
      drawing: { ...drawing, text: "User edit" },
    });
    await expect(
      service.command(principal, {
        operation: "drawing_delete",
        chartId: chart.id,
        drawingId,
        expectedDrawingRevision: 1,
      }),
    ).rejects.toThrow("Chart changed");
  });
  it("preserves private worker boundaries and allows selected new drawings on shared charts", async () => {
    const a = await worker("worker-a", false);
    const b = await worker("worker-b", false);
    const privateChart = await create("WORKER", a);
    await expect(
      new CloudCharts(db.prisma).command(b, { operation: "get", chartId: privateChart.id }),
    ).rejects.toThrow("not editable");
    await expect(create("MAIN", a)).rejects.toThrow("not editable");
    const shared = await create("SHARED");
    const published = CloudChartSchema.parse(
      await new CloudCharts(db.prisma).command(a, {
        operation: "drawing_create",
        chartId: shared.id,
        expectedRevision: shared.revision,
        drawing,
      }),
    );
    expect(published.state.drawings[0]?.creatorId).toBe("worker-a");
  });
  it("binds exact broker scope and preserves drawings on instrument changes", async () => {
    const chart = await create();
    const service = new CloudCharts(db.prisma);
    const edited = CloudChartSchema.parse(
      await service.command(principal, {
        operation: "drawing_create",
        chartId: chart.id,
        expectedRevision: 1,
        drawing,
      }),
    );
    const next = CloudChartSchema.parse(
      await service.command(principal, {
        operation: "set_instrument",
        chartId: chart.id,
        expectedRevision: 2,
        accountId,
        instrumentId: otherInstrumentId,
      }),
    );
    expect(next.brokerSymbol).toBe("EURUSDm");
    expect(next.state.drawings[0]?.instrumentId).toBe(instrumentId);
    await expect(
      service.command(principal, {
        operation: "set_instrument",
        chartId: chart.id,
        expectedRevision: 3,
        accountId: "foreign",
        instrumentId,
      }),
    ).rejects.toThrow("not editable");
    expect(edited.state.drawings[0]?.creator).toBe("USER");
  });
  it("projects only fresh operation events; reconnect begins with durable sync", async () => {
    const actor = await worker();
    const chart = await create("MAIN", actor);
    const realtime = new InMemoryRealtimeFanout();
    const abort = new AbortController();
    const stream = followChartEvents({
      prisma: db.prisma,
      realtime,
      ownerUserId: owner,
      chartId: chart.id,
      signal: abort.signal,
    });
    expect((await stream.next()).value?.operation).toBe("SYNC");
    const packet = stream.next();
    await new CloudCharts(db.prisma, realtime).command(actor, {
      operation: "drawing_create",
      chartId: chart.id,
      expectedRevision: 1,
      drawing,
    });
    const event = (await packet).value;
    expect(event?.actor).toBe("BOT");
    expect(event?.points[0]?.price).toBe("2700.123456789123");
    abort.abort();
    await stream.return(undefined);
    const reopened = followChartEvents({
      prisma: db.prisma,
      realtime,
      ownerUserId: owner,
      chartId: chart.id,
    });
    expect((await reopened.next()).value).toMatchObject({
      operation: "SYNC",
      points: [],
      revision: 2,
    });
    await reopened.return(undefined);
    await realtime.close();
  });
  const definition = {
    definitionVersion: 1,
    name: "Fixture mean",
    description: "Safe fixture analysis",
    parameters: [{ name: "period", min: 1, max: 32, default: 3, integer: true }],
    nodes: [
      { id: "close", op: "input", field: "close" },
      { id: "average", op: "rolling_mean", input: "close", window: { parameter: "period" } },
    ],
    outputs: [{ id: "average", node: "average", label: "Mean", type: "line", pane: "PRICE" }],
  };
  it("registers tested immutable versions and leaves historical chart instances pinned", async () => {
    const registry = new ChartIndicators(db.prisma);
    const first = CustomIndicatorSchema.parse(
      await registry.command(principal, { operation: "create", definition }),
    );
    const chart = await create();
    const withIndicator = CloudChartSchema.parse(
      await new CloudCharts(db.prisma).command(principal, {
        operation: "indicator_add",
        chartId: chart.id,
        expectedRevision: 1,
        indicator: {
          definitionId: first.id,
          definitionVersion: 1,
          parameters: {},
          pane: "PRICE",
          visible: true,
        },
      }),
    );
    const second = CustomIndicatorSchema.parse(
      await registry.command(principal, {
        operation: "create",
        previousId: first.id,
        expectedVersion: 1,
        definition: {
          ...definition,
          parameters: [{ name: "period", min: 1, max: 32, default: 5, integer: true }],
        },
      }),
    );
    expect(second.version).toBe(2);
    expect(second.id).toBe(first.id);
    const restored = CloudChartSchema.parse(
      await new CloudCharts(db.prisma).command(principal, { operation: "get", chartId: chart.id }),
    );
    expect(restored.state.indicators[0]).toMatchObject({
      definitionVersion: 1,
      parameters: { period: 3 },
    });
    expect(withIndicator.state.indicators).toEqual(restored.state.indicators);
    await expect(
      db.prisma.chartIndicatorDefinition.update({
        where: { id_version: { id: first.id, version: 1 } },
        data: { name: "changed" },
      }),
    ).rejects.toThrow("immutable");
    expect(
      CustomIndicatorSchema.parse(
        await registry.command(principal, { operation: "get", id: first.id, version: 1 }),
      ).definition.parameters[0]?.default,
    ).toBe(3);
  });
  it("detects version conflicts even when stale requested content already exists", async () => {
    const registry = new ChartIndicators(db.prisma);
    const first = CustomIndicatorSchema.parse(
      await registry.command(principal, { operation: "create", definition }),
    );
    await registry.command(principal, {
      operation: "create",
      previousId: first.id,
      expectedVersion: 1,
      definition: { ...definition, description: "Version 2" },
    });
    await expect(
      registry.command(principal, {
        operation: "create",
        previousId: first.id,
        expectedVersion: 1,
        definition,
      }),
    ).rejects.toThrow("version conflict");
  });
  it("refuses forged validation or security status and never grants authority from a definition", async () => {
    await expect(
      new ChartIndicators(db.prisma).command(principal, {
        operation: "create",
        definition,
        securityStatus: "SAFE_IR",
      }),
    ).rejects.toThrow();
    expect(await db.prisma.chartIndicatorDefinition.count()).toBe(0);
  });
  it("validates parameters and object revision independently from another user's chart object", async () => {
    const chart = await create();
    const service = new CloudCharts(db.prisma);
    await expect(
      service.command(principal, {
        operation: "indicator_add",
        chartId: chart.id,
        expectedRevision: 1,
        indicator: {
          definitionId: "builtin:SMA",
          definitionVersion: 1,
          parameters: { period: 0 },
          pane: "PRICE",
          visible: true,
        },
      }),
    ).rejects.toThrow("bounds");
    const updated = CloudChartSchema.parse(
      await service.command(principal, {
        operation: "indicator_add",
        chartId: chart.id,
        expectedRevision: 1,
        indicator: {
          definitionId: "builtin:SMA",
          definitionVersion: 1,
          parameters: { period: 3 },
          pane: "PRICE",
          visible: true,
        },
      }),
    );
    const instance = updated.state.indicators[0];
    if (!instance) throw new Error("Fixture indicator");
    const bot = await worker();
    await expect(
      service.command(bot, {
        operation: "indicator_remove",
        chartId: chart.id,
        indicatorId: instance.id,
        expectedIndicatorRevision: 1,
      }),
    ).rejects.toThrow("not editable");
    await service.command(principal, {
      operation: "indicator_update",
      chartId: chart.id,
      indicatorId: instance.id,
      expectedIndicatorRevision: 1,
      indicator: {
        definitionId: "builtin:SMA",
        definitionVersion: 1,
        parameters: { period: 4 },
        pane: "SEPARATE",
        visible: false,
      },
    });
    await expect(
      service.command(principal, {
        operation: "indicator_remove",
        chartId: chart.id,
        indicatorId: instance.id,
        expectedIndicatorRevision: 1,
      }),
    ).rejects.toThrow("changed");
  });
  it("cannot register indicator definitions after execution ownership is lost", async () => {
    const bot = await worker();
    await db.prisma.run.update({
      where: { id: bot.execution?.runId },
      data: { leaseOwner: "worker-b", leaseFence: 2 },
    });
    await expect(
      new ChartIndicators(db.prisma).command(bot, { operation: "create", definition }),
    ).rejects.toThrow("not editable");
    expect(await db.prisma.chartIndicatorDefinition.count()).toBe(0);
  });
  it("imports safe JSON through existing owner-scoped artifacts and deduplicates its final hash", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(definition));
    const store: ArtifactStore = {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { stream: false },
      }),
      put: async () => ({ id: "fixture", hash: "fixture" }),
      get: async () => bytes,
      remove: async () => {},
    };
    const artifact = await db.prisma.artifact.create({
      data: {
        spaceId: "fixture-space",
        userId: owner,
        name: "indicator.json",
        mimeType: "application/json",
        size: bytes.byteLength,
        hash: "fixture",
        storageKey: "fixture",
      },
    });
    const registry = new ChartIndicators(db.prisma, store);
    const first = CustomIndicatorSchema.parse(
      await registry.command(principal, { operation: "import", artifactId: artifact.id }),
    );
    const second = CustomIndicatorSchema.parse(
      await registry.command(principal, { operation: "import", artifactId: artifact.id }),
    );
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      source: "USER_IMPORTED",
      originalFilename: "indicator.json",
      createdBy: owner,
      securityStatus: "SAFE_IR",
    });
    expect(await db.prisma.chartIndicatorDefinition.count()).toBe(1);
  });
  it.each(["indicator.py", "indicator.js", "indicator.pine"])(
    "rejects unsupported uploaded format %s before reading source",
    async (name) => {
      let read = false;
      const store: ArtifactStore = {
        describe: () => ({
          id: "fixture",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { stream: false },
        }),
        put: async () => ({ id: "fixture", hash: "fixture" }),
        get: async () => {
          read = true;
          throw new Error("must not read");
        },
        remove: async () => {},
      };
      const artifact = await db.prisma.artifact.create({
        data: {
          spaceId: "fixture-space",
          userId: owner,
          name,
          mimeType: "text/plain",
          size: 100,
          hash: "fixture",
          storageKey: "fixture",
        },
      });
      await expect(
        new ChartIndicators(db.prisma, store).command(principal, {
          operation: "import",
          artifactId: artifact.id,
        }),
      ).rejects.toThrow("safe indicator JSON");
      expect(read).toBe(false);
    },
  );
  it("refuses foreign-owner and peer-private uploaded artifacts", async () => {
    const bot = await worker();
    const artifact = await db.prisma.artifact.create({
      data: {
        spaceId: "fixture-space",
        userId: owner,
        name: "indicator.json",
        mimeType: "application/json",
        size: 10,
        hash: "fixture",
        storageKey: "fixture",
      },
    });
    const store: ArtifactStore = {
      describe: () => ({
        id: "fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { stream: false },
      }),
      put: async () => ({ id: "fixture", hash: "fixture" }),
      get: async () => {
        throw new Error("must not read");
      },
      remove: async () => {},
    };
    await expect(
      new ChartIndicators(db.prisma, store).command(bot, {
        operation: "import",
        artifactId: artifact.id,
      }),
    ).rejects.toThrow("safe indicator JSON");
    await expect(
      new ChartIndicators(db.prisma, store).command(
        { ownerUserId: "other" },
        { operation: "search" },
      ),
    ).rejects.toThrow("Owner session");
  });
});
