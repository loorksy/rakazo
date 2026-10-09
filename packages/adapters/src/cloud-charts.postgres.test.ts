import { CloudChartSchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { followChartEvents } from "./chart-events.js";
import type { ChartActor } from "./cloud-charts.js";
import { CloudCharts } from "./cloud-charts.js";
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
      .$executeRaw`TRUNCATE cloud_charts, trading_connections, organization, deployment_settings CASCADE`;
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
});
