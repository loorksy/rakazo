import { createHash } from "node:crypto";
import type { BrokerQuote, MarketWatch } from "@rakazo/contracts";
import {
  MarketConditionSchema,
  MarketWatchCommandSchema,
  MarketWatchSchema,
} from "@rakazo/contracts";
import {
  ChartConflictError,
  ChartPermissionError,
  marketConditionSide,
  observeMarketCondition,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import type { ChartActor } from "./cloud-charts.js";
import { fenceChartExecution } from "./cloud-charts.js";
import { createDurableBotWake } from "./durable-bot-wake.js";

type Row = Prisma.MarketWatchGetPayload<Record<never, never>>;
function project(row: Row): MarketWatch {
  if (row.formatVersion !== 1) throw new Error("Unsupported market watch format");
  return MarketWatchSchema.parse({
    version: 1,
    id: row.id,
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    botId: row.botId,
    condition: row.condition,
    expiresAt: row.expiresAt.toISOString(),
    summary: row.summary,
    revision: row.revision,
    wakeGeneration: row.wakeGeneration,
    status: row.status,
    lastSourceTime: row.lastSourceTime?.toISOString() ?? null,
    triggeredRunId: row.triggeredRunId,
  });
}
export class MarketWatches {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async command(
    actor: ChartActor,
    raw: unknown,
    operationKey?: string,
  ): Promise<MarketWatch | MarketWatch[]> {
    await requireTradingOwner(this.prisma, actor.ownerUserId);
    const command = MarketWatchCommandSchema.parse(raw);
    if (actor.botId && "botId" in command && command.botId && command.botId !== actor.botId)
      throw new ChartPermissionError();
    const settings = await this.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    const targetBotId = actor.botId ?? (command.operation === "create" ? command.botId : undefined);
    const bot = targetBotId
      ? await this.prisma.bot.findFirst({
          where: {
            userId: actor.ownerUserId,
            spaceId: settings.ownerSpaceId ?? "",
            id: targetBotId,
            archivedAt: null,
          },
          select: { id: true },
        })
      : null;
    if ((actor.botId && !actor.execution) || (!bot && command.operation === "create"))
      throw new ChartPermissionError();
    const scope = { ownerUserId: actor.ownerUserId, ...(actor.botId ? { botId: bot!.id } : {}) };
    if (command.operation === "list")
      return (
        await this.prisma.marketWatch.findMany({
          where: scope,
          take: 1000,
          orderBy: { createdAt: "desc" },
        })
      ).map(project);
    return this.prisma.$transaction(async (tx) => {
      await fenceChartExecution(tx, actor);
      if (command.operation === "cancel") {
        await tx.$queryRaw`SELECT id FROM market_watches WHERE id = ${command.id} FOR UPDATE`;
        const row = await tx.marketWatch.findFirst({ where: { id: command.id, ...scope } });
        if (!row) throw new ChartPermissionError();
        if (row.revision !== command.expectedRevision) throw new ChartConflictError();
        return project(
          await tx.marketWatch.update({
            where: { id: row.id },
            data: { status: "CANCELLED", revision: { increment: 1 } },
          }),
        );
      }
      const remaining = Date.parse(command.expiresAt) - this.now().getTime();
      if (remaining <= 0 || remaining > 90 * 86400000)
        throw new Error("Choose a future watch expiry within 90 days");
      const connection = await tx.tradingConnection.findFirst({
        where: { id: command.accountId, ownerUserId: actor.ownerUserId, revokedAt: null },
      });
      const instrument = await tx.brokerInstrument.findFirst({
        where: { id: command.instrumentId, accountId: command.accountId, active: true },
      });
      if (!connection || !instrument) throw new ChartPermissionError();
      await tx.$queryRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;
      const observed = await tx.marketWatch.findMany({
        where: { accountId: command.accountId, status: "ACTIVE", expiresAt: { gt: this.now() } },
        select: { instrumentId: true },
        distinct: ["instrumentId"],
      });
      if (
        !observed.some((row) => row.instrumentId === command.instrumentId) &&
        observed.length >= 256
      )
        throw new Error("Active instrument capacity reached");
      const material = JSON.stringify(command);
      const creationKey = createHash("sha256")
        .update(JSON.stringify([actor.ownerUserId, bot!.id, operationKey ?? material]))
        .digest("hex");
      const prior = await tx.marketWatch.findUnique({ where: { creationKey } });
      if (prior) {
        if (
          prior.accountId !== command.accountId ||
          prior.instrumentId !== command.instrumentId ||
          JSON.stringify(MarketConditionSchema.parse(prior.condition)) !==
            JSON.stringify(command.condition) ||
          prior.expiresAt.getTime() !== Date.parse(command.expiresAt) ||
          prior.summary !== command.summary
        )
          throw new Error("Watch request identity changed");
        return project(prior);
      }
      if ((await tx.marketWatch.count({ where: { ownerUserId: actor.ownerUserId } })) >= 1000)
        throw new Error("Watch capacity reached");
      return project(
        await tx.marketWatch.create({
          data: {
            creationKey,
            ownerUserId: actor.ownerUserId,
            botId: bot!.id,
            accountId: command.accountId,
            instrumentId: command.instrumentId,
            condition: command.condition,
            summary: command.summary,
            expiresAt: new Date(command.expiresAt),
          },
        }),
      );
    });
  }
}

/** Called only inside the account's fenced provider transaction. One logical event -> one existing Run. */
export async function observeMarketWatches(
  tx: Prisma.TransactionClient,
  quote: BrokerQuote,
  now: Date,
  witness?: { id: string; previousValue: string | null; previousSourceTime: string | null },
): Promise<string[]> {
  const instrument = await tx.brokerInstrument.findFirst({
    where: {
      id: quote.instrumentId,
      accountId: quote.accountId,
      brokerSymbol: quote.brokerSymbol,
      active: true,
    },
    select: { id: true },
  });
  if (!instrument) return [];
  const watches = await tx.marketWatch.findMany({
    where: {
      accountId: quote.accountId,
      instrumentId: quote.instrumentId,
      status: "ACTIVE",
      ...(witness ? { id: witness.id } : {}),
    },
    take: 1000,
  });
  const runs: string[] = [];
  for (const candidate of watches) {
    await tx.$queryRaw`SELECT id FROM market_watches WHERE id = ${candidate.id} FOR UPDATE`;
    const watch = await tx.marketWatch.findUniqueOrThrow({ where: { id: candidate.id } });
    if (watch.status !== "ACTIVE") continue;
    if (watch.expiresAt <= now) {
      await tx.marketWatch.update({
        where: { id: watch.id },
        data: { status: "EXPIRED", revision: { increment: 1 } },
      });
      continue;
    }
    const result = observeMarketCondition({
      condition: MarketConditionSchema.parse(watch.condition),
      quote,
      now,
      previousValue: witness ? witness.previousValue : watch.lastValue,
      previousSourceTime: witness
        ? witness.previousSourceTime
        : (watch.lastSourceTime?.toISOString() ?? null),
    });
    if (!result.observed) continue;
    const condition = MarketConditionSchema.parse(watch.condition);
    if (
      !result.fire &&
      result.value !== null &&
      watch.lastValue !== null &&
      marketConditionSide(result.value, condition.price) ===
        marketConditionSide(watch.lastValue, condition.price)
    )
      continue;
    const current = await tx.marketWatch.update({
      where: { id: watch.id },
      data: {
        lastValue: result.value,
        lastSourceTime: new Date(quote.sourceTime),
        revision: { increment: 1 },
        ...(result.fire
          ? {
              status: "DELIVERY_NEEDED",
              wakeGeneration: { increment: 1 },
              pendingEvidence: {
                brokerSymbol: quote.brokerSymbol,
                price: result.value,
                sourceTime: quote.sourceTime,
              },
            }
          : {}),
      },
    });
    if (result.fire) {
      const run = await deliverMarketWake(tx, current);
      if (run) runs.push(run);
    }
  }
  return runs;
}
async function deliverMarketWake(tx: Prisma.TransactionClient, watch: Row): Promise<string | null> {
  const runId = await createDurableBotWake(tx, {
    ownerUserId: watch.ownerUserId,
    botId: watch.botId,
    key: `market-watch:${watch.id}:${watch.wakeGeneration}`,
    prompt: `A saved broker market condition occurred. Watch ${watch.id}: ${watch.summary}\nEvidence: ${JSON.stringify(watch.pendingEvidence)}\nReport the useful result through this conversation. This observation grants no financial authority.`,
  });
  if (!runId) return null;
  await tx.marketWatch.update({
    where: { id: watch.id },
    data: { status: "FIRED", triggeredRunId: runId, revision: { increment: 1 } },
  });
  return runId;
}
/** Recovery of captured delivery is metadata-only; the existing Run reconciler owns job recovery. */
export async function recoverMarketWakes(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<string[]> {
  const pending = await tx.marketWatch.findMany({
    where: { accountId, status: "DELIVERY_NEEDED" },
    take: 20,
  });
  const runs: string[] = [];
  for (const row of pending) {
    await tx.$queryRaw`SELECT id FROM market_watches WHERE id = ${row.id} FOR UPDATE`;
    const current = await tx.marketWatch.findUniqueOrThrow({ where: { id: row.id } });
    if (current.status !== "DELIVERY_NEEDED") continue;
    const run = await deliverMarketWake(tx, current);
    if (run) runs.push(run);
  }
  return runs;
}
