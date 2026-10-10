import type { BrokerReadSession } from "@rakazo/adapter-kit";
import {
  SignedTradingDecimalSchema,
  TradingDecimalSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { financialDecimal, financialUnits } from "@rakazo/core";
import type { BrokerLeaseToken, Prisma, PrismaClient } from "@rakazo/db";
import { withBrokerSessionFence } from "@rakazo/db";
import { z } from "zod";

import type { BrokerPositionHistory } from "./broker-history.js";
import { closedPositionPnl, recordBrokerHistories } from "./broker-history.js";

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
      const history = await recordBrokerHistories(
        tx,
        connection.ownerUserId,
        token.accountId,
        histories,
        prior?.observedAt ?? null,
        now,
      );
      const supervisions = await tx.tradingPositionSupervision.findMany({
        where: { accountId: token.accountId, status: "ACTIVE" },
        take: 1001,
      });
      if (supervisions.length > 1000) throw new Error("Supervision capacity exceeded");
      const reasons = new Set<string>();
      if (history.conflict) reasons.add("PROVIDER_HISTORY_CONFLICT");
      if (previous) {
        if (prior?.generation !== token.generation) reasons.add("PROVIDER_SESSION_GAP");
        if (
          financialUnits(previous.account.balance) + history.cash !==
            financialUnits(state.account.balance) ||
          previous.account.currency !== state.account.currency ||
          previous.account.accountMode !== state.account.accountMode ||
          previous.account.tradingAllowed !== state.account.tradingAllowed
        )
          reasons.add("ACCOUNT_STATE_CHANGED");
        for (const supervision of supervisions) {
          const expected = z.object({ position: Position.nullable() }).parse(supervision.expected);
          const position = state.positions.find((row) => row.id === supervision.positionId) ?? null;
          if (JSON.stringify(position) !== JSON.stringify(expected.position))
            reasons.add("SUPERVISED_POSITION_CHANGED");
        }
        const known = await tx.tradingRiskReservation.findMany({
          where: {
            accountId: token.accountId,
            mode: "LIVE",
            status: { in: ["COMMITTED", "RELEASED"] },
          },
        });
        const knownIds = new Set(known.map((row) => row.providerReference));
        for (const reservation of known) {
          if (reservation.kind === "MANAGEMENT" || reservation.status === "RELEASED") continue;
          const current = (reservation.kind === "POSITION" ? state.positions : state.orders).find(
            (row) => row.id === reservation.providerReference,
          );
          if (
            !reservation.providerState ||
            JSON.stringify(
              reservation.kind === "POSITION"
                ? Position.parse(reservation.providerState)
                : Order.parse(reservation.providerState),
            ) !== JSON.stringify(current)
          )
            reasons.add("ATTRIBUTED_EXPOSURE_CHANGED");
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

          let pnl = 0n;
          let verified = true;
          for (const reservation of reservations) {
            const valuation = state.account.positionValuations?.find(
              (row) => row.id === reservation.providerReference,
            );
            const closed = history.verified.get(reservation.providerReference ?? "");
            const realized = closed ? closedPositionPnl(closed) : null;
            if (valuation && reservation.status === "COMMITTED")
              pnl += financialUnits(valuation.profit);
            else if (
              realized !== null &&
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
          await tx.tradingMandate.update({
            where: { id: mandate.id },
            data: {
              observedAt: now,
              missionPnl: financialDecimal(pnl),
              dailyPnl: financialDecimal(pnl),
              ...(target && mandate.status === "ACTIVE"
                ? { status: "TARGET_REACHED", revision: { increment: 1 } }
                : {}),
              ...(stopped && mandate.status === "ACTIVE"
                ? { status: "RISK_STOPPED", revision: { increment: 1 } }
                : {}),
              observedState: {
                version: 1,
                generation: token.generation,
                accounting: "EXACT_PROVIDER_MARK",
                pnl: financialDecimal(pnl),
              },
            },
          });
        }
      }
      return [...reasons];
    },
    now,
  );
}

export function remainingVolume(before: string, closed: string): string {
  const difference = financialUnits(before) - financialUnits(closed);
  if (difference < 0n) throw new Error("Close exceeds supervised position volume");
  return financialDecimal(difference);
}
