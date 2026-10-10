import type { BrokerReadSession } from "@rakazo/adapter-kit";
import { SignedTradingDecimalSchema, TradingDecimalSchema } from "@rakazo/contracts";
import { financialDecimal, financialUnits } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { z } from "zod";

const Id = z.string().min(1).max(128);
export const BrokerPositionHistorySchema = z.object({
  accountId: Id,
  positionId: Id,
  synchronized: z.boolean(),
  deals: z
    .array(
      z.object({
        id: Id,
        positionId: Id,
        time: z.iso.datetime({ offset: true }),
        entry: z.enum(["IN", "OUT"]),
        volume: TradingDecimalSchema,
        profit: SignedTradingDecimalSchema,
        commission: SignedTradingDecimalSchema,
        swap: SignedTradingDecimalSchema,
      }),
    )
    .max(1000),
});
export type BrokerPositionHistory = z.infer<typeof BrokerPositionHistorySchema>;
export const dealPnl = (deal: BrokerPositionHistory["deals"][number]) =>
  financialUnits(deal.profit) + financialUnits(deal.commission) + financialUnits(deal.swap);
export function closedPositionPnl(history: BrokerPositionHistory) {
  if (!history.synchronized || !history.deals.length) return null;
  const incoming = history.deals
    .filter((deal) => deal.entry === "IN")
    .reduce((sum, deal) => sum + financialUnits(deal.volume), 0n);
  const outgoing = history.deals
    .filter((deal) => deal.entry === "OUT")
    .reduce((sum, deal) => sum + financialUnits(deal.volume), 0n);
  if (incoming === 0n || incoming !== outgoing) return null;
  return history.deals.reduce((sum, deal) => sum + dealPnl(deal), 0n);
}
export async function readBrokerHistory(prisma: PrismaClient, session: BrokerReadSession) {
  if (!session.positionHistory) return [];
  const rows = await prisma.tradingRiskReservation.findMany({
    where: {
      accountId: session.accountId,
      mode: "LIVE",
      kind: "POSITION",
      status: { in: ["COMMITTED", "RELEASED"] },
    },
    select: { providerReference: true },
    distinct: ["providerReference"],
    take: 101,
  });
  if (rows.length > 100) return [];
  const histories: BrokerPositionHistory[] = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    const chunk = await Promise.all(
      rows.slice(offset, offset + 4).map(async (row) => {
        if (!row.providerReference) return null;
        try {
          const result = BrokerPositionHistorySchema.parse(
            await session.positionHistory!(row.providerReference),
          );
          if (result.accountId !== session.accountId || result.positionId !== row.providerReference)
            throw new Error("History scope mismatch");
          return result;
        } catch {
          return null;
        }
      }),
    );
    histories.push(...chunk.filter((row): row is BrokerPositionHistory => row !== null));
  }
  return histories;
}
/** Append complete normalized provider deal evidence. Corrections or omissions require attention. */
export async function recordBrokerHistories(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  accountId: string,
  histories: BrokerPositionHistory[],
  previousAt: Date | null,
  now: Date,
) {
  let cash = 0n;
  const verified = new Map<string, BrokerPositionHistory>();
  let conflict = false;
  for (const raw of histories) {
    const history = BrokerPositionHistorySchema.parse(raw);
    const attribution = await tx.tradingRiskReservation.findFirst({
      where: {
        ownerUserId,
        accountId,
        mode: "LIVE",
        kind: "POSITION",
        status: { in: ["COMMITTED", "RELEASED"] },
        providerReference: history.positionId,
      },
      select: { id: true },
    });
    if (
      !attribution ||
      history.accountId !== accountId ||
      !history.synchronized ||
      history.deals.some(
        (deal) =>
          deal.positionId !== history.positionId || Date.parse(deal.time) > now.getTime() + 2000,
      ) ||
      new Set(history.deals.map((deal) => deal.id)).size !== history.deals.length
    ) {
      conflict = true;
      continue;
    }
    const row = await tx.financialJournal.findFirst({
      where: {
        accountId,
        mode: "LIVE",
        event: "PROVIDER_POSITION_HISTORY",
        entry: { path: ["positionId"], equals: history.positionId },
      },
      orderBy: { createdAt: "desc" },
    });
    const previous = row ? BrokerPositionHistorySchema.parse(row.entry) : null;
    if (
      previous?.deals.some(
        (old) =>
          JSON.stringify(history.deals.find((deal) => deal.id === old.id)) !== JSON.stringify(old),
      )
    ) {
      conflict = true;
      continue;
    }
    const known = new Set(previous?.deals.map((deal) => deal.id));
    for (const deal of history.deals)
      if (!known.has(deal.id) && previousAt && Date.parse(deal.time) >= previousAt.getTime())
        cash += dealPnl(deal);
    if (!previous || previous.deals.length !== history.deals.length)
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId,
          mode: "LIVE",
          event: "PROVIDER_POSITION_HISTORY",
          entry: history,
        },
      });
    verified.set(history.positionId, history);
  }
  return { cash, verified, conflict, cashText: financialDecimal(cash) };
}
