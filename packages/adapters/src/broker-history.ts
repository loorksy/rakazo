import { createHash } from "node:crypto";
import type { BrokerReadSession } from "@rakazo/adapter-kit";
import { SignedTradingDecimalSchema, TradingDecimalSchema } from "@rakazo/contracts";
import { financialDecimal, financialUnits } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { sanitizedBrokerError } from "./metaapi-normalize.js";

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
        /** Absent on providers that cannot classify closes; such closes are never assumed protective. */
        reason: z
          .enum(["STOP_LOSS", "TAKE_PROFIT", "STOP_OUT", "MANUAL", "API", "OTHER"])
          .optional(),
        clientId: Id.nullable().optional(),
      }),
    )
    .max(1000),
});
export type BrokerPositionHistory = z.infer<typeof BrokerPositionHistorySchema>;
type Deal = BrokerPositionHistory["deals"][number];
/** Fields whose later change is a provider correction rather than added detail. */
const settled = (deal: Deal | undefined) =>
  deal &&
  JSON.stringify([
    deal.id,
    deal.positionId,
    deal.time,
    deal.entry,
    deal.volume,
    deal.profit,
    deal.commission,
    deal.swap,
  ]);

/** Attributed changes read in one observation; the rest wait for the next tick. */
export const REQUIRED_HISTORY_READS_PER_TICK = 32;
/** Closed attributed positions whose final history is still unknown. */
export const PENDING_HISTORY_READS_PER_TICK = 8;
export const HISTORY_READ_CONCURRENCY = 4;
/** Complete histories are re-read slowly so provider corrections still surface. */
export const HISTORY_REVERIFY_AGE_MS = 15 * 60_000;
export const HISTORY_REVERIFY_INTERVAL_MS = 10_000;
/** An observation may wait this long for required history before it becomes drift. */
export const HISTORY_PENDING_TIMEOUT_MS = 60_000;
/** Tolerated broker/server clock skew when deciding whether a deal predates the last observation. */
export const DEAL_CLOCK_SKEW_MS = 60_000;

export const dealPnl = (deal: Deal) =>
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

const canonicalDeals = (deals: Deal[]) =>
  [...deals].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id));
const dealsHash = (deals: Deal[]) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalDeals(deals)))
    .digest("hex");

/** Per-session read progress. Survives ticks so rate limiting cannot stall an observation forever. */
export interface BrokerHistoryCache {
  snapshotRevision: number | null;
  required: Map<string, { volume: string | null; history: BrokerPositionHistory }>;
  retryAt: Map<string, number>;
  verifiedAt: number;
}
export const createBrokerHistoryCache = (): BrokerHistoryCache => ({
  snapshotRevision: null,
  required: new Map(),
  retryAt: new Map(),
  verifiedAt: 0,
});

export interface BrokerHistoryRead {
  histories: BrokerPositionHistory[];
  /** Attributed positions whose change since the previous snapshot is not yet explained. */
  missing: string[];
}

const SnapshotPositions = z.array(z.object({ id: Id, volume: TradingDecimalSchema }).loose());

async function attributedPositions(prisma: PrismaClient, accountId: string, ids: string[]) {
  const found = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await prisma.tradingRiskReservation.findMany({
      where: {
        accountId,
        mode: "LIVE",
        // A filled pending entry keeps the order ticket as its position identity.
        kind: { in: ["POSITION", "PENDING"] },
        status: { in: ["COMMITTED", "RELEASED"] },
        providerReference: { in: ids.slice(offset, offset + 500) },
      },
      select: { providerReference: true },
      distinct: ["providerReference"],
    });
    for (const row of rows) if (row.providerReference) found.add(row.providerReference);
  }
  return found;
}

/**
 * Bounded incremental provider history. Positions whose change must explain the current
 * observation come first; closed positions with unknown final history and slow correction
 * checks share a small fixed budget. Nothing is dropped because an account traded a lot.
 */
export async function readBrokerHistory(
  prisma: PrismaClient,
  session: BrokerReadSession,
  current: { positions: Array<{ id: string; volume: string }> },
  cache: BrokerHistoryCache = createBrokerHistoryCache(),
  now: Date = new Date(),
): Promise<BrokerHistoryRead> {
  const prior = await prisma.tradingBrokerSnapshot.findUnique({
    where: { accountId: session.accountId },
    select: { revision: true, positions: true, observedAt: true },
  });
  if (cache.snapshotRevision !== (prior?.revision ?? null)) {
    cache.snapshotRevision = prior?.revision ?? null;
    cache.required.clear();
  }
  const previous = prior ? SnapshotPositions.parse(prior.positions) : null;
  const open = new Map(current.positions.map((row) => [row.id, row.volume]));
  const required = new Set<string>();
  if (previous) {
    const before = new Map(previous.map((row) => [row.id, row.volume]));
    const changed = [
      ...current.positions.filter((row) => before.get(row.id) !== row.volume).map((row) => row.id),
      ...previous.filter((row) => !open.has(row.id)).map((row) => row.id),
    ];
    for (const id of await attributedPositions(prisma, session.accountId, changed))
      required.add(id);
    // Our own position can open and close between two observations; it never appears in a diff.
    const recent = await prisma.tradingRiskReservation.findMany({
      where: {
        accountId: session.accountId,
        mode: "LIVE",
        kind: "POSITION",
        status: { in: ["COMMITTED", "RELEASED"] },
        providerReference: { not: null },
        updatedAt: { gte: new Date(prior!.observedAt.getTime() - DEAL_CLOCK_SKEW_MS) },
      },
      select: { providerReference: true },
      distinct: ["providerReference"],
      take: 1000,
    });
    const unseen = recent.flatMap((row) =>
      row.providerReference &&
      !open.has(row.providerReference) &&
      !before.has(row.providerReference)
        ? [row.providerReference]
        : [],
    );
    const finalized = new Set(
      unseen.length
        ? (
            await prisma.tradingPositionHistory.findMany({
              where: { accountId: session.accountId, positionId: { in: unseen }, complete: true },
              select: { positionId: true },
            })
          ).map((row) => row.positionId)
        : [],
    );
    for (const id of unseen) if (!finalized.has(id)) required.add(id);
  }
  if (!session.positionHistory) return { histories: [], missing: [...required].sort() };
  const stale = [...required]
    .filter((id) => cache.required.get(id)?.volume !== (open.get(id) ?? null))
    .sort();
  const scheduled = stale.slice(0, REQUIRED_HISTORY_READS_PER_TICK);
  const pending = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT r."providerReference" AS id
    FROM trading_risk_reservations r
    LEFT JOIN trading_position_histories h
      ON h."accountId" = r."accountId" AND h."positionId" = r."providerReference"
    WHERE r."accountId" = ${session.accountId} AND r.mode = 'LIVE' AND r.kind = 'POSITION'
      AND r.status IN ('COMMITTED', 'RELEASED') AND r."providerReference" IS NOT NULL
      AND (h."positionId" IS NULL OR h.complete = false)
      AND NOT (r."providerReference" = ANY(${[...open.keys(), ...required]}::text[]))
    GROUP BY r."providerReference"
    ORDER BY MIN(h."verifiedAt") ASC NULLS FIRST, r."providerReference" ASC
    LIMIT ${PENDING_HISTORY_READS_PER_TICK * 4}`;
  const optional = pending
    .map((row) => row.id)
    .filter((id) => (cache.retryAt.get(id) ?? 0) <= now.getTime())
    .slice(0, PENDING_HISTORY_READS_PER_TICK);
  if (now.getTime() - cache.verifiedAt >= HISTORY_REVERIFY_INTERVAL_MS) {
    cache.verifiedAt = now.getTime();
    const due = await prisma.tradingPositionHistory.findFirst({
      where: {
        accountId: session.accountId,
        complete: true,
        verifiedAt: { lt: new Date(now.getTime() - HISTORY_REVERIFY_AGE_MS) },
      },
      orderBy: { verifiedAt: "asc" },
      select: { positionId: true },
    });
    if (due && !required.has(due.positionId) && !optional.includes(due.positionId))
      optional.push(due.positionId);
  }
  const histories: BrokerPositionHistory[] = [];
  const queue = [...scheduled, ...optional];
  let limited = false;
  const read = async (id: string) => {
    if (limited) return;
    try {
      const history = BrokerPositionHistorySchema.parse(await session.positionHistory!(id));
      if (history.accountId !== session.accountId || history.positionId !== id)
        throw new Error("History scope mismatch");
      cache.retryAt.delete(id);
      if (required.has(id)) {
        if (history.synchronized) cache.required.set(id, { volume: open.get(id) ?? null, history });
      } else histories.push(history);
    } catch (error) {
      if (sanitizedBrokerError(error).code === "RATE_LIMITED") limited = true;
      if (!required.has(id)) cache.retryAt.set(id, now.getTime() + 30_000);
    }
  };
  for (let offset = 0; offset < queue.length && !limited; offset += HISTORY_READ_CONCURRENCY)
    await Promise.all(queue.slice(offset, offset + HISTORY_READ_CONCURRENCY).map(read));
  if (cache.retryAt.size > 4096) cache.retryAt.clear();
  const explained = [...required].filter(
    (id) => cache.required.get(id)?.volume === (open.get(id) ?? null),
  );
  return {
    histories: [...explained.map((id) => cache.required.get(id)!.history), ...histories],
    missing: [...required].filter((id) => !explained.includes(id)).sort(),
  };
}

/**
 * Record complete normalized provider deal evidence and the cash it explains since the previous
 * observation. Changed or omitted deals require attention; nothing is inferred from absence.
 */
export async function recordBrokerHistories(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  accountId: string,
  histories: BrokerPositionHistory[],
  previous: { observedAt: Date; positionIds: Set<string> } | null,
  now: Date,
) {
  let cash = 0n;
  let conflict = false;
  const recorded = new Set<string>();
  for (const raw of histories) {
    const history = BrokerPositionHistorySchema.parse(raw);
    if (recorded.has(history.positionId)) continue;
    recorded.add(history.positionId);
    const attribution = await tx.tradingRiskReservation.findFirst({
      where: {
        ownerUserId,
        accountId,
        mode: "LIVE",
        kind: { in: ["POSITION", "PENDING"] },
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
          deal.positionId !== history.positionId ||
          Date.parse(deal.time) > now.getTime() + DEAL_CLOCK_SKEW_MS,
      ) ||
      new Set(history.deals.map((deal) => deal.id)).size !== history.deals.length
    ) {
      conflict = true;
      continue;
    }
    const stored = await tx.tradingPositionHistory.findUnique({
      where: { accountId_positionId: { accountId, positionId: history.positionId } },
    });
    const known = stored ? BrokerPositionHistorySchema.shape.deals.parse(stored.deals) : [];
    if (
      known.some(
        (old) => settled(history.deals.find((deal) => deal.id === old.id)) !== settled(old),
      )
    ) {
      conflict = true;
      continue;
    }
    const knownIds = new Set(known.map((deal) => deal.id));
    const fresh = history.deals.filter((deal) => !knownIds.has(deal.id));
    if (previous)
      for (const deal of fresh) {
        // An entry for a position the previous observation already held is reflected there.
        if (deal.entry === "IN" && previous.positionIds.has(history.positionId)) continue;
        if (Date.parse(deal.time) < previous.observedAt.getTime() - DEAL_CLOCK_SKEW_MS) continue;
        cash += dealPnl(deal);
      }
    const deals = canonicalDeals(history.deals);
    const realized = closedPositionPnl(history);
    const data = {
      ownerUserId,
      deals,
      synchronized: history.synchronized,
      complete: realized !== null,
      realizedPnl: realized === null ? null : financialDecimal(realized),
      dealCount: deals.length,
      dealsHash: dealsHash(deals),
      verifiedAt: now,
    };
    if (!stored || fresh.length)
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId,
          mode: "LIVE",
          event: "PROVIDER_POSITION_HISTORY",
          entry: { ...history, deals },
        },
      });
    await tx.tradingPositionHistory.upsert({
      where: { accountId_positionId: { accountId, positionId: history.positionId } },
      create: { accountId, positionId: history.positionId, ...data },
      update: { ...data, ...(fresh.length ? { revision: { increment: 1 } } : {}) },
    });
  }
  return { cash, conflict, cashText: financialDecimal(cash) };
}

/** Exact realized PnL for closed attributed positions, from the verified persisted history. */
export async function realizedPositionPnl(
  tx: Prisma.TransactionClient,
  accountId: string,
  positionIds: string[],
) {
  const rows = positionIds.length
    ? await tx.tradingPositionHistory.findMany({
        where: { accountId, positionId: { in: positionIds }, complete: true, synchronized: true },
        select: { positionId: true, realizedPnl: true },
      })
    : [];
  return new Map(
    rows.flatMap((row) =>
      row.realizedPnl === null ? [] : [[row.positionId, financialUnits(row.realizedPnl.toFixed())]],
    ),
  );
}
