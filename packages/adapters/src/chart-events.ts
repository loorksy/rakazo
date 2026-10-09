import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { ChartEvent } from "@rakazo/contracts";
import { ChartEventSchema } from "@rakazo/contracts";
import { ChartPermissionError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
export async function* followChartEvents(input: {
  prisma: PrismaClient;
  realtime: RealtimeFanout;
  ownerUserId: string;
  chartId: string;
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
}): AsyncGenerator<ChartEvent> {
  await requireTradingOwner(input.prisma, input.ownerUserId);
  let wake: (() => void) | undefined;
  const queue: ChartEvent[] = [];
  const unsubscribe = await input.realtime.subscribe(`chart:${input.chartId}`, (raw) => {
    try {
      const parsed = ChartEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.chartId === input.chartId) {
        queue.push(parsed.data);
        if (queue.length > 8) queue.shift();
        wake?.();
      }
    } catch {
      /* Discard invalid transport data. */
    }
  });
  const abort = () => wake?.();
  input.signal?.addEventListener("abort", abort);
  try {
    while (!input.signal?.aborted) {
      if (input.stillAuthorized && !(await input.stillAuthorized()))
        throw new ChartPermissionError();
      await requireTradingOwner(input.prisma, input.ownerUserId);
      const row = await input.prisma.cloudChart.findFirst({
        where: { id: input.chartId, ownerUserId: input.ownerUserId },
        select: { revision: true },
      });
      if (!row) throw new ChartPermissionError();
      if (queue.length) {
        for (const event of queue.splice(0)) if (event.revision <= row.revision) yield event;
      } else
        yield {
          chartId: input.chartId,
          revision: row.revision,
          actor: "USER",
          operation: "SYNC",
          at: new Date().toISOString(),
          points: [],
        };
      if (queue.length) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, 5000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        if (input.signal?.aborted) wake();
      });
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await unsubscribe();
  }
}
