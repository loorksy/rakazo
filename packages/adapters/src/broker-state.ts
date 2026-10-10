import type { BrokerReadSession } from "@rakazo/adapter-kit";
import {
  SignedTradingDecimalSchema,
  TradingDecimalSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { financialCeil, financialDecimal, financialUnits } from "@rakazo/core";
import type { BrokerLeaseToken, PrismaClient } from "@rakazo/db";
import { Prisma, withBrokerSessionFence } from "@rakazo/db";
import { z } from "zod";

import type { BrokerPositionHistory } from "./broker-history.js";
import {
  BrokerPositionHistorySchema,
  DEAL_CLOCK_SKEW_MS,
  HISTORY_PENDING_TIMEOUT_MS,
  realizedPositionPnl,
  recordBrokerHistories,
} from "./broker-history.js";

/** Returned when required provider history is still being read; nothing was persisted. */
export const HISTORY_PENDING = "PROVIDER_HISTORY_PENDING";

const Id = z.string().min(1).max(128);
export const BrokerPositionStateSchema = z.object({
  id: Id,
  accountId: Id,
  symbol: Id,
  side: z.enum(["BUY", "SELL"]),
  volume: TradingDecimalSchema,
  entry: TradingDecimalSchema,
  stopLoss: TradingDecimalSchema.nullable(),
  takeProfit: TradingDecimalSchema.nullable(),
  clientId: Id.nullable(),
});
const Position = BrokerPositionStateSchema;
export const BrokerOrderStateSchema = Position.omit({ entry: true }).extend({
  orderType: z.enum(["LIMIT", "STOP", "STOP_LIMIT"]),
  price: TradingDecimalSchema,
  stopLimitPrice: TradingDecimalSchema.nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
const Order = BrokerOrderStateSchema;
const Account = z.object({
  accountId: Id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  balance: SignedTradingDecimalSchema,
  equity: SignedTradingDecimalSchema,
  margin: TradingDecimalSchema,
  freeMargin: SignedTradingDecimalSchema,
  environment: z.enum(["DEMO", "REAL"]),
  accountMode: z.enum(["HEDGING", "NETTING", "UNKNOWN"]),
  platform: z.enum(["mt4", "mt5"]),
  tradingAllowed: z.boolean(),
  positionValuations: z
    .array(z.object({ id: Id, profit: SignedTradingDecimalSchema }))
    .max(1000)
    .optional(),
});
export const BrokerStateSchema = z.object({
  account: Account,
  positions: z.array(Position).max(1000),
  orders: z.array(Order).max(1000),
});
export type BrokerState = z.infer<typeof BrokerStateSchema>;
export async function readBrokerState(session: BrokerReadSession): Promise<BrokerState> {
  const [account, positions, orders] = await Promise.all([
    session.account(),
    session.positions(),
    session.orders(),
  ]);
  const state = BrokerStateSchema.parse({
    account: {
      ...account,
      positionValuations: positions.map((position) => ({
        id: position.id,
        profit: position.profit,
      })),
    },
    positions,
    orders,
  });
  if (
    state.account.accountId !== session.accountId ||
    [...state.positions, ...state.orders].some((row) => row.accountId !== session.accountId) ||
    new Set(state.positions.map((row) => row.id)).size !== state.positions.length ||
    new Set(state.orders.map((row) => row.id)).size !== state.orders.length
  )
    throw new Error("Provider state identity mismatch");
  return state;
}

export async function captureSupervision(
  tx: Prisma.TransactionClient,
  input: {
    ownerUserId: string;
    botId: string;
    accountId: string;
    mandateId: string;
    positionId: string;
    now: Date;
  },
) {
  const snapshot = await tx.tradingBrokerSnapshot.findUniqueOrThrow({
    where: { accountId: input.accountId },
  });
  const lease = await tx.brokerSessionLease.findUniqueOrThrow({
    where: { accountId: input.accountId },
  });
  if (
    snapshot.generation !== lease.generation ||
    lease.state !== "CONNECTED" ||
    input.now.getTime() - snapshot.observedAt.getTime() > 15000 ||
    snapshot.observedAt.getTime() > input.now.getTime() + 2000
  )
    throw new Error("Fresh trusted supervision baseline required");
  const state = BrokerStateSchema.parse(snapshot);
  const position = state.positions.find((row) => row.id === input.positionId);
  if (!position || state.account.accountMode !== "HEDGING")
    throw new Error("Exact hedging position attribution required");
  if (
    await tx.tradingPositionSupervision.count({
      where: {
        accountId: input.accountId,
        positionId: input.positionId,
        status: { in: ["PROPOSED", "ACTIVE", "PAUSED"] },
      },
    })
  )
    throw new Error("Position already assigned to supervision");
  if (position.clientId?.startsWith("rz_"))
    throw new Error("Agent position requires its original mandate");
  const mandate = await tx.tradingMandate.findUniqueOrThrow({ where: { id: input.mandateId } });
  const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
  const relatedOrders = envelope.supervisedOrderIds.map((id) => {
    const order = state.orders.find((row) => row.id === id);
    if (!order || order.symbol !== position.symbol)
      throw new Error("Exact selected supervision order baseline required");
    return order;
  });
  return tx.tradingPositionSupervision.create({
    data: {
      ownerUserId: input.ownerUserId,
      botId: input.botId,
      accountId: input.accountId,
      mandateId: input.mandateId,
      positionId: input.positionId,
      baseline: { position, account: state.account, relatedOrders },
      expected: { position },
      status: "PROPOSED",
    },
  });
}

export async function approveSupervision(
  tx: Prisma.TransactionClient,
  mandateId: string,
  now: Date,
) {
  const supervision = await tx.tradingPositionSupervision.findUniqueOrThrow({
    where: { mandateId },
  });
  const mandate = await tx.tradingMandate.findUniqueOrThrow({ where: { id: mandateId } });
  const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
  if (
    supervision.status !== "PROPOSED" ||
    envelope.supervisionPositionId !== supervision.positionId ||
    envelope.allowedOperations.includes("OPEN") ||
    envelope.riskIncreasePermissions.length
  )
    throw new Error("Supervision cannot grant entry or risk increase authority");
  const snapshot = await tx.tradingBrokerSnapshot.findUniqueOrThrow({
    where: { accountId: mandate.accountId },
  });
  const state = BrokerStateSchema.parse(snapshot);
  const baseline = z.object({ position: Position }).parse(supervision.baseline);
  if (
    now.getTime() - snapshot.observedAt.getTime() > 15000 ||
    JSON.stringify(state.positions.find((row) => row.id === supervision.positionId)) !==
      JSON.stringify(baseline.position)
  )
    throw new Error("Supervision baseline changed; propose again");
  await tx.tradingPositionSupervision.update({
    where: { id: supervision.id },
    data: { status: "ACTIVE" },
  });
  // Conservatively reserve the entire authorized envelope for this pre-existing owner exposure.
  // Subsequent deterministic management assessments can reduce it; no exposure is newly entered.
  await tx.tradingRiskReservation.create({
    data: {
      ownerUserId: mandate.ownerUserId,
      accountId: mandate.accountId,
      mode: "LIVE",
      mandateId,
      effectId: `supervision:${supervision.id}`,
      actionFingerprint: mandate.fingerprint,
      kind: "POSITION",
      risk: envelope.maxOpenRisk,
      exposure: envelope.maxNotional,
      margin: envelope.allocatedCapital,
      status: "COMMITTED",
      executionGeneration: 1,
      providerReference: supervision.positionId,
      providerState: baseline.position,
    },
  });
  const related = z
    .object({ relatedOrders: z.array(Order) })
    .parse(supervision.baseline).relatedOrders;
  for (const order of related) {
    const current = state.orders.find((row) => row.id === order.id);
    if (JSON.stringify(current) !== JSON.stringify(order))
      throw new Error("Selected pending order changed before supervision approval");
    await tx.tradingRiskReservation.create({
      data: {
        ownerUserId: mandate.ownerUserId,
        accountId: mandate.accountId,
        mode: "LIVE",
        mandateId,
        effectId: `supervision:${supervision.id}:order:${order.id}`,
        actionFingerprint: mandate.fingerprint,
        kind: "PENDING",
        risk: envelope.maxOpenRisk,
        exposure: envelope.maxNotional,
        margin: envelope.allocatedCapital,
        status: "COMMITTED",
        executionGeneration: 1,
        providerReference: order.id,
        providerState: order,
      },
    });
  }
}

export async function observeBrokerState(
  prisma: PrismaClient,
  token: BrokerLeaseToken,
  state: BrokerState,
  now: Date,
  histories: BrokerPositionHistory[] = [],
  missingHistory: string[] = [],
) {
  // Even fixture providers must pass the secret-stripping schema before persistence.
  state = BrokerStateSchema.parse(state);
  return withBrokerSessionFence(
    prisma,
    token,
    async (tx) => {
      const connection = await tx.tradingConnection.findUniqueOrThrow({
        where: { id: token.accountId },
      });
      const prior = await tx.tradingBrokerSnapshot.findUnique({
        where: { accountId: token.accountId },
      });
      const previous = prior ? BrokerStateSchema.parse(prior) : null;
      // Keep the last explained snapshot until required history arrives. Its age blocks new
      // LIVE risk meanwhile; after the timeout the gap itself becomes owner-visible drift.
      if (
        prior &&
        missingHistory.length &&
        now.getTime() - prior.observedAt.getTime() < HISTORY_PENDING_TIMEOUT_MS
      )
        return [HISTORY_PENDING];
      const history = await recordBrokerHistories(
        tx,
        connection.ownerUserId,
        token.accountId,
        histories,
        prior && previous
          ? {
              observedAt: prior.observedAt,
              positionIds: new Set(previous.positions.map((row) => row.id)),
            }
          : null,
        now,
      );
      const supervisions = await tx.tradingPositionSupervision.findMany({
        where: { accountId: token.accountId, status: "ACTIVE" },
        take: 1001,
      });
      if (supervisions.length > 1000) throw new Error("Supervision capacity exceeded");
      const reasons = new Set<string>();
      let transitions: Awaited<ReturnType<typeof classifyAttributedOutcomes>> | null = null;
      if (history.conflict) reasons.add("PROVIDER_HISTORY_CONFLICT");
      if (missingHistory.length) reasons.add("PROVIDER_HISTORY_UNAVAILABLE");
      if (previous) {
        // A reconnect alone is not drift: the full state diff and deal history below detect
        // every net change that happened while the session was down.
        if (
          financialUnits(previous.account.balance) + history.cash !==
            financialUnits(state.account.balance) ||
          previous.account.currency !== state.account.currency ||
          previous.account.accountMode !== state.account.accountMode ||
          previous.account.tradingAllowed !== state.account.tradingAllowed
        )
          reasons.add("ACCOUNT_STATE_CHANGED");
        const committed = await tx.tradingRiskReservation.findMany({
          where: {
            accountId: token.accountId,
            mode: "LIVE",
            status: "COMMITTED",
            kind: { in: ["POSITION", "PENDING"] },
          },
          take: 10001,
        });
        if (committed.length > 10000) throw new Error("Risk ledger capacity exceeded");
        const visible = [
          ...new Set(
            [...state.positions, ...state.orders, ...previous.positions, ...previous.orders].map(
              (row) => row.id,
            ),
          ),
        ];
        const referenced = visible.length
          ? await tx.tradingRiskReservation.findMany({
              where: {
                accountId: token.accountId,
                mode: "LIVE",
                status: { in: ["COMMITTED", "RELEASED"] },
                providerReference: { in: visible },
              },
              select: { providerReference: true },
            })
          : [];
        const knownIds = new Set([...committed, ...referenced].map((row) => row.providerReference));
        const outcomes = await classifyAttributedOutcomes(
          tx,
          token.accountId,
          committed,
          state,
          now,
        );
        for (const reason of outcomes.reasons) reasons.add(reason);
        transitions = outcomes;
        for (const supervision of supervisions) {
          const expected = z.object({ position: Position.nullable() }).parse(supervision.expected);
          const position = state.positions.find((row) => row.id === supervision.positionId) ?? null;
          if (
            JSON.stringify(position) !== JSON.stringify(expected.position) &&
            !outcomes.exits.some((exit) => exit.position.id === supervision.positionId)
          )
            reasons.add("SUPERVISED_POSITION_CHANGED");
        }
        if (
          state.positions.some(
            (row) => !previous.positions.some((old) => old.id === row.id) && !knownIds.has(row.id),
          )
        )
          reasons.add("UNATTRIBUTED_POSITION_OPENED");
        if (
          state.orders.some(
            (order) =>
              !previous.orders.some((old) => old.id === order.id) && !knownIds.has(order.id),
          )
        )
          reasons.add("UNATTRIBUTED_PENDING_ORDER_OPENED");
        for (const old of previous.orders) {
          const current = state.orders.find((row) => row.id === old.id);
          if (JSON.stringify(old) !== JSON.stringify(current) && !knownIds.has(old.id))
            reasons.add("EXTERNAL_ORDER_CHANGED");
        }
        if (state.account.accountMode !== "HEDGING" && state.positions.length)
          reasons.add("NETTING_ATTRIBUTION_UNSAFE");
      }
      if (
        reasons.size &&
        !(await tx.tradingDriftEvent.count({
          where: { accountId: token.accountId, resolvedAt: null },
        }))
      ) {
        await tx.tradingDriftEvent.create({
          data: {
            ownerUserId: connection.ownerUserId,
            accountId: token.accountId,
            reason: [...reasons].sort().join("_AND_"),
            evidence: { version: 1, previous, current: state, generation: token.generation },
          },
        });
        await tx.tradingPositionSupervision.updateMany({
          where: { accountId: token.accountId, status: "ACTIVE" },
          data: { status: "PAUSED" },
        });
        await tx.tradingMandate.updateMany({
          where: {
            accountId: token.accountId,
            mode: "LIVE",
            status: { in: ["ACTIVE", "APPROVED_WAITING"] },
          },
          data: { status: "NEEDS_ATTENTION", revision: { increment: 1 } },
        });
        await tx.financialJournal.create({
          data: {
            ownerUserId: connection.ownerUserId,
            accountId: token.accountId,
            mode: "LIVE",
            event: "MANUAL_DRIFT_DETECTED",
            entry: { version: 1, reasons: [...reasons].sort() },
          },
        });
      }
      await tx.tradingBrokerSnapshot.upsert({
        where: { accountId: token.accountId },
        create: {
          accountId: token.accountId,
          generation: token.generation,
          ...state,
          observedAt: now,
        },
        update: {
          generation: token.generation,
          ...state,
          observedAt: now,
          revision: { increment: 1 },
        },
      });
      if (!reasons.size && transitions)
        await applyAttributedOutcomes(tx, connection.ownerUserId, token, transitions, now);
      // Refresh mission accounting only when exact attributed provider valuation is known.
      // A realized cash/exposure change needs history reconciliation; never infer zero profit.
      if (!reasons.size) {
        const mandates = await tx.tradingMandate.findMany({
          where: { accountId: token.accountId, mode: "LIVE", status: { in: ["ACTIVE", "PAUSED"] } },
          take: 1000,
        });
        for (const mandate of mandates) {
          const reservations = await tx.tradingRiskReservation.findMany({
            where: {
              mandateId: mandate.id,
              kind: "POSITION",
              status: { in: ["COMMITTED", "RELEASED"] },
            },
          });
          const realizedByPosition = await realizedPositionPnl(
            tx,
            token.accountId,
            reservations.flatMap((row) =>
              row.providerReference &&
              !state.positions.some((position) => position.id === row.providerReference)
                ? [row.providerReference]
                : [],
            ),
          );

          let pnl = 0n;
          let verified = true;
          for (const reservation of reservations) {
            const valuation = state.account.positionValuations?.find(
              (row) => row.id === reservation.providerReference,
            );
            const realized = realizedByPosition.get(reservation.providerReference ?? "");
            if (valuation && reservation.status === "COMMITTED")
              pnl += financialUnits(valuation.profit);
            else if (
              realized !== undefined &&
              !state.positions.some((position) => position.id === reservation.providerReference)
            )
              pnl += realized;
            else {
              verified = false;
              break;
            }
          }
          const supervision = await tx.tradingPositionSupervision.findUnique({
            where: { mandateId: mandate.id },
          });
          if (supervision) {
            const baseline = z.object({ account: Account }).parse(supervision.baseline);
            const original = baseline.account.positionValuations?.find(
              (row) => row.id === supervision.positionId,
            );
            if (!original) verified = false;
            else pnl -= financialUnits(original.profit);
          }
          if (!verified) continue;
          const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
          const objective = TradingGoalInputSchema.parse(
            (await tx.tradingGoal.findUniqueOrThrow({ where: { id: mandate.goalId } })).definition,
          );
          const stopped = pnl <= -financialUnits(envelope.maxMissionLoss);
          const target =
            objective.targetProfit !== null && pnl >= financialUnits(objective.targetProfit);
          const terminal = stopped ? "RISK_STOPPED" : target ? "TARGET_REACHED" : null;
          await tx.tradingMandate.update({
            where: { id: mandate.id },
            data: {
              observedAt: now,
              missionPnl: financialDecimal(pnl),
              dailyPnl: financialDecimal(pnl),
              ...(terminal && mandate.status === "ACTIVE"
                ? { status: terminal, revision: { increment: 1 } }
                : {}),
              observedState: {
                version: 1,
                generation: token.generation,
                accounting: "EXACT_PROVIDER_MARK",
                pnl: financialDecimal(pnl),
              },
            },
          });
          if (terminal && mandate.status === "ACTIVE") {
            const wakeKey = `live:${terminal}:${mandate.id}:${mandate.revision + 1}`;
            await tx.tradingMissionWake.upsert({
              where: { wakeKey },
              create: { mandateId: mandate.id, wakeKey, kind: "ACCOUNT_EVENT", dueAt: now },
              update: {},
            });
            await tx.financialJournal.create({
              data: {
                ownerUserId: mandate.ownerUserId,
                accountId: token.accountId,
                mode: "LIVE",
                mandateId: mandate.id,
                goalId: mandate.goalId,
                event: `LIVE_${terminal}`,
                entry: { version: 1, pnl: financialDecimal(pnl), generation: token.generation },
              },
            });
          }
        }
      }
      return [...reasons];
    },
    now,
  );
}

type Reservation = Awaited<
  ReturnType<Prisma.TransactionClient["tradingRiskReservation"]["findMany"]>
>[number];
type PositionState = z.infer<typeof Position>;
type OrderState = z.infer<typeof Order>;
const max = (first: bigint, second: bigint) => (first > second ? first : second);

/** A pending entry filled at a different price keeps its reservation; adverse slippage raises it. */
function filledCapacity(order: OrderState, position: PositionState, reservation: Reservation) {
  if (order.stopLoss === null) return null;
  const stop = financialUnits(order.stopLoss);
  const distance = (entry: string) =>
    order.side === "BUY" ? financialUnits(entry) - stop : stop - financialUnits(entry);
  const before = distance(order.price);
  const after = distance(position.entry);
  if (before <= 0n || after <= 0n) return null;
  const price = financialUnits(order.price);
  const entry = financialUnits(position.entry);
  const scale = (value: string, numerator: bigint, denominator: bigint) =>
    financialDecimal(
      max(financialUnits(value), financialCeil(financialUnits(value) * numerator, denominator)),
    );
  return {
    risk: scale(reservation.risk.toFixed(), after, before),
    exposure: scale(reservation.exposure.toFixed(), entry, price),
    margin: scale(reservation.margin.toFixed(), entry, price),
  };
}

/**
 * Broker-side outcomes the approved envelope already anticipated: protective stop/target
 * exits, pending entries filling unchanged, and pending entries expiring at their stated time.
 * Anything else that changed attributed exposure is drift requiring the owner.
 */
async function classifyAttributedOutcomes(
  tx: Prisma.TransactionClient,
  accountId: string,
  committed: Reservation[],
  state: BrokerState,
  now: Date,
) {
  const reasons = new Set<string>();
  const exits: Array<{
    reservation: Reservation;
    position: PositionState;
    reason: "STOP_LOSS" | "TAKE_PROFIT";
    realizedPnl: string;
  }> = [];
  const fills: Array<{
    reservation: Reservation;
    order: OrderState;
    position: PositionState;
    capacity: { risk: string; exposure: string; margin: string };
  }> = [];
  const expiries: Array<{ reservation: Reservation; order: OrderState }> = [];
  const inFlight = new Set(
    (
      await tx.tradingProviderExecution.findMany({
        where: { accountId, status: { in: ["SENT", "UNCERTAIN"] } },
        select: { clientId: true },
      })
    ).map((row) => row.clientId),
  );
  for (const reservation of committed) {
    const rows = reservation.kind === "POSITION" ? state.positions : state.orders;
    const current = rows.find((row) => row.id === reservation.providerReference);
    const expected =
      reservation.kind === "POSITION"
        ? Position.safeParse(reservation.providerState)
        : Order.safeParse(reservation.providerState);
    if (expected.success && JSON.stringify(expected.data) === JSON.stringify(current)) continue;
    if (!expected.success || current) {
      reasons.add("ATTRIBUTED_EXPOSURE_CHANGED");
      continue;
    }
    if (reservation.kind === "POSITION") {
      const position = Position.parse(expected.data);
      const stored = await tx.tradingPositionHistory.findUnique({
        where: { accountId_positionId: { accountId, positionId: position.id } },
      });
      const outgoing = stored
        ? BrokerPositionHistorySchema.shape.deals
            .parse(stored.deals)
            .filter((deal) => deal.entry === "OUT")
        : [];
      // Our own uncertain close is resolved by provider reconciliation, not inferred here.
      if (outgoing.length && outgoing.every((deal) => deal.clientId && inFlight.has(deal.clientId)))
        continue;
      const reason = outgoing[0]?.reason;
      if (
        stored?.complete &&
        stored.realizedPnl !== null &&
        (reason === "STOP_LOSS" || reason === "TAKE_PROFIT") &&
        outgoing.every((deal) => deal.reason === reason) &&
        (reason === "STOP_LOSS" ? position.stopLoss : position.takeProfit) !== null
      )
        exits.push({ reservation, position, reason, realizedPnl: stored.realizedPnl.toFixed() });
      else reasons.add("ATTRIBUTED_POSITION_CLOSED_EXTERNALLY");
      continue;
    }
    const order = Order.parse(expected.data);
    const filled = state.positions.find((row) => row.id === order.id);
    const capacity = filled ? filledCapacity(order, filled, reservation) : null;
    if (
      filled &&
      capacity &&
      filled.symbol === order.symbol &&
      filled.side === order.side &&
      filled.volume === order.volume &&
      filled.stopLoss === order.stopLoss &&
      filled.takeProfit === order.takeProfit &&
      (filled.clientId === null || filled.clientId === order.clientId)
    )
      fills.push({ reservation, order, position: filled, capacity });
    else if (
      !filled &&
      order.expiresAt !== null &&
      Date.parse(order.expiresAt) <= now.getTime() + DEAL_CLOCK_SKEW_MS
    )
      expiries.push({ reservation, order });
    else reasons.add("ATTRIBUTED_ORDER_CHANGED_EXTERNALLY");
  }
  return { reasons, exits, fills, expiries };
}

async function applyAttributedOutcomes(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  token: BrokerLeaseToken,
  outcomes: Awaited<ReturnType<typeof classifyAttributedOutcomes>>,
  now: Date,
) {
  const record = async (
    reservation: Reservation,
    event: string,
    entry: Record<string, string | number | null>,
  ) => {
    const mandate = await tx.tradingMandate.findUnique({ where: { id: reservation.mandateId } });
    await tx.financialJournal.create({
      data: {
        ownerUserId,
        accountId: token.accountId,
        mode: "LIVE",
        mandateId: reservation.mandateId,
        goalId: mandate?.goalId,
        event,
        entry: { version: 1, generation: token.generation, ...entry },
      },
    });
    if (mandate)
      await tx.tradingMissionWake.upsert({
        where: { wakeKey: `live:${event}:${reservation.id}` },
        create: {
          mandateId: mandate.id,
          wakeKey: `live:${event}:${reservation.id}`,
          kind: "ACCOUNT_EVENT",
          dueAt: now,
        },
        update: {},
      });
  };
  for (const exit of outcomes.exits) {
    await tx.tradingRiskReservation.update({
      where: { id: exit.reservation.id },
      data: { status: "RELEASED", providerState: Prisma.JsonNull },
    });
    await tx.tradingPositionSupervision.updateMany({
      where: { accountId: token.accountId, positionId: exit.position.id, status: "ACTIVE" },
      data: { status: "CLOSED", expected: { position: null } },
    });
    await record(exit.reservation, "LIVE_PROTECTIVE_EXIT", {
      positionId: exit.position.id,
      reason: exit.reason,
      realizedPnl: exit.realizedPnl,
    });
  }
  for (const fill of outcomes.fills) {
    await tx.tradingRiskReservation.update({
      where: { id: fill.reservation.id },
      data: { ...fill.capacity, kind: "POSITION", providerState: fill.position },
    });
    await record(fill.reservation, "LIVE_ORDER_FILLED", {
      orderId: fill.order.id,
      positionId: fill.position.id,
      entry: fill.position.entry,
      risk: fill.capacity.risk,
    });
  }
  for (const expiry of outcomes.expiries) {
    await tx.tradingRiskReservation.update({
      where: { id: expiry.reservation.id },
      data: { status: "RELEASED", providerState: Prisma.JsonNull },
    });
    await record(expiry.reservation, "LIVE_ORDER_EXPIRED", {
      orderId: expiry.order.id,
      expiresAt: expiry.order.expiresAt,
    });
  }
}

export function remainingVolume(before: string, closed: string): string {
  const difference = financialUnits(before) - financialUnits(closed);
  if (difference < 0n) throw new Error("Close exceeds supervised position volume");
  return financialDecimal(difference);
}
