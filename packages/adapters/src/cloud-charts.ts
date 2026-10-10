import { randomUUID } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { ChartCommand, ChartResponse, CloudChart } from "@rakazo/contracts";
import {
  ChartCommandSchema,
  ChartResponseSchema,
  CloudChartSchema,
  CloudChartStateSchema,
} from "@rakazo/contracts";
import {
  CHART_DRAWING_CAPABILITIES,
  ChartConflictError,
  ChartPermissionError,
  changeChartState,
  indicatorParameters,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import { loadChartIndicator } from "./chart-indicator-definitions.js";

export interface ChartActor {
  ownerUserId: string;
  botId?: string;
  execution?: { runId: string; holder: string; generation: number };
}
type ChartRow = Prisma.CloudChartGetPayload<Record<never, never>>;
function project(row: ChartRow): CloudChart {
  const { formatVersion, ...view } = row;
  if (formatVersion !== 1) throw new Error("Unsupported chart state version");
  return CloudChartSchema.parse({
    ...view,
    state: CloudChartStateSchema.parse(row.state),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
/** Backend owns chart identity/state. Tools never supply actor, creator or execution ownership. */
export class CloudCharts {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly realtime?: RealtimeFanout,
  ) {}
  private async actor(input: ChartActor) {
    await requireTradingOwner(this.prisma, input.ownerUserId);
    if (!input.botId) return { id: input.ownerUserId, user: true };
    const settings = await this.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    if (!settings?.ownerSpaceId) throw new ChartPermissionError();
    const bot = await this.prisma.bot.findFirst({
      where: { id: input.botId, userId: input.ownerUserId, spaceId: settings.ownerSpaceId },
      select: { id: true },
    });
    if (!bot || !input.execution) throw new ChartPermissionError();
    return { id: input.botId, user: false };
  }
  private permit(row: ChartRow, actor: Awaited<ReturnType<CloudCharts["actor"]>>) {
    if (
      actor.user ||
      row.scope === "SHARED" ||
      (row.scope === "WORKER" && row.ownerBotId === actor.id) ||
      (row.scope === "PRIVATE" && row.ownerBotId === actor.id)
    )
      return;
    throw new ChartPermissionError();
  }
  async command(input: ChartActor, raw: unknown): Promise<ChartResponse> {
    return ChartResponseSchema.parse(await this.perform(input, raw));
  }
  private async perform(input: ChartActor, raw: unknown): Promise<unknown> {
    const actor = await this.actor(input);
    const cmd: ChartCommand = ChartCommandSchema.parse(raw);
    if (cmd.operation === "capabilities")
      return {
        version: 1,
        library: "KLineChart Pro 0.1.1 / KLineChart 9.8.12",
        drawingTools: CHART_DRAWING_CAPABILITIES.map(([id, anchors]) => ({
          id,
          anchors,
          editable: true,
          semantic: true,
        })),
        operations: [
          "create",
          "get",
          "list",
          "set_instrument",
          "set_timeframe",
          "set_viewport",
          "zoom",
          "pan",
          "jump",
          "reset_view",
          "drawing_create",
          "drawing_update",
          "drawing_delete",
          "indicator_add",
          "indicator_update",
          "indicator_remove",
        ],
      };
    if (cmd.operation === "list") {
      const rows = await this.prisma.cloudChart.findMany({
        where: { ownerUserId: input.ownerUserId },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return rows
        .filter(
          (row) =>
            actor.user ||
            row.scope === "SHARED" ||
            (row.scope === "PRIVATE" && row.ownerBotId === actor.id) ||
            row.ownerBotId === actor.id,
        )
        .map(project);
    }
    if (cmd.operation === "get") {
      const row = await this.prisma.cloudChart.findFirst({
        where: { id: cmd.chartId, ownerUserId: input.ownerUserId },
      });
      if (!row) throw new ChartPermissionError();
      this.permit(row, actor);
      return project(row);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await fenceChartExecution(tx, input);
      if (cmd.operation === "create") {
        if (input.botId && cmd.botId && input.botId !== cmd.botId) throw new ChartPermissionError();
        const ownerBotId = input.botId ?? cmd.botId ?? null;
        if (ownerBotId) {
          const settings = await tx.deploymentSettings.findUniqueOrThrow({
            where: { id: "default" },
          });
          if (
            !(await tx.bot.findFirst({
              where: {
                id: ownerBotId,
                userId: input.ownerUserId,
                spaceId: settings.ownerSpaceId ?? "",
                archivedAt: null,
              },
            }))
          )
            throw new ChartPermissionError();
        }
        await tx.$queryRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;
        if ((await tx.cloudChart.count({ where: { ownerUserId: input.ownerUserId } })) >= 100)
          throw new ChartPermissionError();
        const instrument = await this.instrument(
          tx,
          input.ownerUserId,
          cmd.accountId,
          cmd.instrumentId,
        );
        return project(
          await tx.cloudChart.create({
            data: {
              ownerUserId: input.ownerUserId,
              ownerBotId,
              scope: cmd.scope,
              accountId: cmd.accountId,
              instrumentId: cmd.instrumentId,
              brokerSymbol: instrument.brokerSymbol,
              state: {
                version: 1,
                timeframe: cmd.timeframe,
                viewport: { from: null, to: null, candleCount: 200, rightSpacing: 40 },
                drawings: [],
                indicators: [],
                preferences: { theme: "dark", timezone: "UTC" },
              },
            },
          }),
        );
      }
      await tx.$queryRaw`SELECT id FROM cloud_charts WHERE id = ${cmd.chartId} FOR UPDATE`;
      const row = await tx.cloudChart.findFirst({
        where: { id: cmd.chartId, ownerUserId: input.ownerUserId },
      });
      if (!row) throw new ChartPermissionError();
      this.permit(row, actor);
      if ("indicator" in cmd) {
        const record = await loadChartIndicator(
          this.prisma,
          input.ownerUserId,
          cmd.indicator.definitionId,
          cmd.indicator.definitionVersion,
        );
        cmd.indicator.parameters = indicatorParameters(record.definition, cmd.indicator.parameters);
      }
      const state = changeChartState({
        state: CloudChartStateSchema.parse(row.state),
        revision: row.revision,
        instrumentId: row.instrumentId,
        command: cmd,
        actor,
        now: new Date(),
        newId: randomUUID(),
      });
      let identity: { accountId: string; instrumentId: string; brokerSymbol: string } | undefined;
      if (cmd.operation === "set_instrument") {
        const instrument = await this.instrument(
          tx,
          input.ownerUserId,
          cmd.accountId,
          cmd.instrumentId,
        );
        identity = {
          accountId: cmd.accountId,
          instrumentId: cmd.instrumentId,
          brokerSymbol: instrument.brokerSymbol,
        };
      }
      return project(
        await tx.cloudChart.update({
          where: { id: row.id },
          data: { ...identity, state, revision: { increment: 1 } },
        }),
      );
    });
    // Durable state is committed before optional animation. A closed client cannot block the operation.
    await this.realtime
      ?.publish(
        `chart:${result.id}`,
        JSON.stringify({
          chartId: result.id,
          revision: result.revision,
          actor: actor.user ? "USER" : "BOT",
          operation: cmd.operation,
          at: new Date().toISOString(),
          points: "drawing" in cmd ? cmd.drawing.points : [],
        }),
      )
      .catch(() => undefined);
    return result;
  }
  private async instrument(
    tx: Prisma.TransactionClient,
    ownerUserId: string,
    accountId: string,
    instrumentId: string,
  ) {
    const connection = await tx.tradingConnection.findFirst({
      where: { id: accountId, ownerUserId, revokedAt: null },
    });
    const instrument = await tx.brokerInstrument.findFirst({
      where: { id: instrumentId, accountId, active: true },
    });
    if (!connection || !instrument) throw new ChartPermissionError();
    return instrument;
  }
}

export async function fenceChartExecution(tx: Prisma.TransactionClient, input: ChartActor) {
  if (!input.botId) return;
  const token = input.execution;
  if (!token) throw new ChartPermissionError();
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${token.runId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: token.runId,
      userId: input.ownerUserId,
      botId: input.botId,
      leaseOwner: token.holder,
      leaseFence: token.generation,
      leaseExpiresAt: { gt: new Date() },
      status: { in: ["leased", "running"] },
    },
  });
  if (!run) throw new ChartPermissionError();
}

/** Prevent a delayed render from publishing over changed chart state or execution ownership. */
export async function guardChartProjection(
  tx: Prisma.TransactionClient,
  actor: ChartActor,
  chartId: string,
  revision: number,
) {
  await fenceChartExecution(tx, actor);
  await tx.$queryRaw`SELECT id FROM cloud_charts WHERE id = ${chartId} FOR UPDATE`;
  const current = await tx.cloudChart.findFirst({
    where: { id: chartId, ownerUserId: actor.ownerUserId },
    select: { revision: true },
  });
  if (current?.revision !== revision) throw new ChartConflictError();
}
