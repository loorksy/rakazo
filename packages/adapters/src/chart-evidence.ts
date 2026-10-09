import type { ChartEvidence } from "@rakazo/contracts";
import { BrokerCandleSchema, ChartEvidenceSchema, CloudChartSchema } from "@rakazo/contracts";
import { ChartConflictError, calculateIndicator } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { loadChartIndicator } from "./chart-indicator-definitions.js";
import type { ChartActor } from "./cloud-charts.js";
import { CloudCharts } from "./cloud-charts.js";
import { requestBrokerRead } from "./trading-connections.js";
/** One shared evidence request for every active indicator, not one provider call per plot. */
export async function chartEvidence(
  prisma: PrismaClient,
  actor: ChartActor,
  chartId: string,
  signal?: AbortSignal,
): Promise<ChartEvidence> {
  const chart = CloudChartSchema.parse(
    await new CloudCharts(prisma).command(actor, { operation: "get", chartId }),
  );
  const raw = await requestBrokerRead(
    prisma,
    actor.ownerUserId,
    {
      operation: "candles",
      accountId: chart.accountId,
      instrumentId: chart.instrumentId,
      timeframe: chart.state.timeframe,
      limit: 1000,
      ...(chart.state.viewport.to ? { before: chart.state.viewport.to } : {}),
    },
    signal,
  );
  const rows = BrokerCandleSchema.array().max(1000).parse(raw);
  if (
    rows.some(
      (c) =>
        c.accountId !== chart.accountId ||
        c.instrumentId !== chart.instrumentId ||
        c.timeframe !== chart.state.timeframe,
    )
  )
    throw new Error("Chart evidence identity mismatch");
  const candles = [...new Map(rows.map((c) => [c.openTime, c])).values()].sort(
    (a, b) => Date.parse(a.openTime) - Date.parse(b.openTime),
  );
  const calculations = await Promise.all(
    chart.state.indicators
      .filter((i) => i.visible)
      .map(async (instance) => {
        const record = await loadChartIndicator(
          prisma,
          actor.ownerUserId,
          instance.definitionId,
          instance.definitionVersion,
        );
        return {
          instanceId: instance.id,
          definitionId: record.id,
          definitionVersion: record.version,
          ...calculateIndicator(record.definition, candles, instance.parameters),
        };
      }),
  );
  const current = await prisma.cloudChart.findUnique({
    where: { id: chartId },
    select: { revision: true },
  });
  if (current?.revision !== chart.revision) throw new ChartConflictError();
  return ChartEvidenceSchema.parse({ chart, candles, calculations });
}
