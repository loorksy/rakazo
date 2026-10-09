import type { JobPublisher } from "@rakazo/adapter-kit";
import { simulationExpiryJob } from "@rakazo/adapter-kit";
import type {
  BrokerQuote,
  SimulationBookState,
  SimulationMarketEvent,
  SimulationPosition,
} from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  BrokerQuoteSchema,
  FinancialActionSchema,
  FinancialEffectContextSchema,
  FinancialEffectOutcomeSchema,
  SimulationBookStateSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import {
  financialDecimal as d,
  FINANCIAL_SCALE,
  financialCeil,
  observeSimulationMarket,
  financialUnits as u,
  valueSimulationBook,
} from "@rakazo/core";
import { financialActionFingerprint } from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";

export function nextSimulationExpiry(state: SimulationBookState): Date | null {
  return state.orders.length
    ? new Date(Math.min(...state.orders.map((row) => Date.parse(row.expiresAt))))
    : null;
}

export async function pauseSimulationObservation(
  tx: Prisma.TransactionClient,
  accountId: string,
  now: Date,
  reason: "BACKPRESSURE" | "CONNECTION_GAP" = "BACKPRESSURE",
) {
  const account = await tx.tradingConnection.findUniqueOrThrow({ where: { id: accountId } });
  await requireTradingOwner(tx, account.ownerUserId);
  const active = await tx.tradingMandate.findMany({
    where: { accountId, ownerUserId: account.ownerUserId, mode: "SIMULATION", status: "ACTIVE" },
    take: 1001,
  });
  if (active.length > 1000) throw new Error("Simulation mandate capacity exceeded");
  for (const mandate of active) {
    await tx.tradingMandate.update({
      where: { id: mandate.id },
      data: { status: "NEEDS_ATTENTION", revision: { increment: 1 } },
    });
    const key = `simulation:${reason}:${mandate.id}:${mandate.revision + 1}`;
    await tx.tradingMissionWake.upsert({
      where: { wakeKey: key },
      create: { mandateId: mandate.id, wakeKey: key, kind: "ACCOUNT_EVENT", dueAt: now },
      update: {},
    });
    await tx.financialJournal.create({
      data: {
        ownerUserId: account.ownerUserId,
        accountId,
        mode: "SIMULATION",
        mandateId: mandate.id,
        goalId: mandate.goalId,
        event: `SIMULATION_OBSERVER_${reason}`,
        entry: { version: 1 },
      },
    });
  }
}

async function confirmedOrigin(
  tx: Prisma.TransactionClient,
  owner: string,
  accountId: string,
  event: SimulationMarketEvent,
) {
  const effect = await tx.externalEffect.findUniqueOrThrow({ where: { id: event.originEffectId } });
  const context = FinancialEffectContextSchema.parse(effect.financialContext);
  const action = FinancialActionSchema.parse(effect.request);
  const receipt = await tx.simulationExecution.findUniqueOrThrow({
    where: { effectId: effect.id },
  });
  const outcome = FinancialEffectOutcomeSchema.parse(receipt.outcome);
  const reservation = await tx.tradingRiskReservation.findUniqueOrThrow({
    where: { effectId: effect.id },
  });
  if (
    context.version !== 2 ||
    context.ownerUserId !== owner ||
    context.accountId !== accountId ||
    context.mode !== "SIMULATION" ||
    action.operation !== "OPEN" ||
    action.mode !== "SIMULATION" ||
    action.accountId !== accountId ||
    action.instrumentId !== event.instrumentId ||
    action.brokerSymbol !== event.brokerSymbol ||
    financialActionFingerprint(action) !== context.actionFingerprint ||
    context.authorizationId !== event.mandateId ||
    context.goalId !== event.goalId ||
    context.planVersion !== event.planVersion ||
    receipt.ownerUserId !== owner ||
    receipt.accountId !== accountId ||
    receipt.mandateId !== event.mandateId ||
    receipt.actionFingerprint !== context.actionFingerprint ||
    outcome.status !== "SUCCEEDED" ||
    outcome.providerReference !== event.targetId ||
    reservation.ownerUserId !== owner ||
    reservation.accountId !== accountId ||
    reservation.mode !== "SIMULATION" ||
    reservation.mandateId !== event.mandateId ||
    reservation.actionFingerprint !== context.actionFingerprint ||
    !["RESERVED", "COMMITTED", "UNCERTAIN"].includes(reservation.status)
  )
    throw new Error("Confirmed simulation observation origin required");
  return reservation;
}

/** A filled pending entry retains its reservation; an adverse gap increases it conservatively. */
function filledCapacity(
  before: SimulationPosition,
  after: SimulationPosition,
  risk: string,
  exposure: string,
  margin: string,
) {
  if (before.stopLoss === null) throw new Error("Bounded simulation order required");
  const distance = (entry: string) =>
    before.side === "BUY"
      ? u(entry) - u(before.stopLoss ?? "0")
      : u(before.stopLoss ?? "0") - u(entry);
  const oldDistance = distance(before.entry),
    newDistance = distance(after.entry);
  if (oldDistance <= 0n) throw new Error("Simulation pending risk cannot be attributed");
  const max = (first: bigint, second: bigint) => (first > second ? first : second);
  return {
    risk: d(
      max(u(risk), newDistance > 0n ? financialCeil(u(risk) * newDistance, oldDistance) : 0n),
    ),
    exposure: d(
      max(
        u(exposure),
        financialCeil(
          u(after.entry) * u(after.volume) * u(after.contractSize),
          FINANCIAL_SCALE * FINANCIAL_SCALE,
        ),
      ),
    ),
    margin: d(max(u(margin), financialCeil(u(margin) * u(after.entry), u(before.entry)))),
  };
}

/** Caller must hold the trusted account row lock (provider fence or existing Graphile expiry job). */
export async function observeSimulationAccount(
  tx: Prisma.TransactionClient,
  accountId: string,
  quotes: BrokerQuote[],
  now: Date,
) {
  await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${accountId} FOR UPDATE`;
  const account = await tx.tradingConnection.findUniqueOrThrow({ where: { id: accountId } });
  await requireTradingOwner(tx, account.ownerUserId);
  if (account.revokedAt) throw new Error("Simulation observation account revoked");
  const book = await tx.simulationBook.findUnique({ where: { accountId } });
  if (!book) return;
  if (book.ownerUserId !== account.ownerUserId) throw new Error("Simulation book owner mismatch");
  let state = SimulationBookStateSchema.parse(book.state);
  if (quotes.length > 256) throw new Error("Simulation observation batch exceeded");
  const active = new Set([...state.positions, ...state.orders].map((row) => row.instrumentId));
  const events: SimulationMarketEvent[] = [];
  const observe = async (quote?: BrokerQuote) => {
    const before = state;
    const result = observeSimulationMarket({ state, quote, now });
    for (const event of result.events) {
      const reservation = await confirmedOrigin(tx, account.ownerUserId, accountId, event);
      if (event.type === "ORDER_FILLED") {
        const order = before.orders.find((row) => row.id === event.targetId);
        // A gapping fill may close immediately. Its fill still has an exact entry in this event.
        if (!order || !event.price) throw new Error("Simulation fill source missing");
        const capacity = filledCapacity(
          order,
          { ...order, entry: event.price },
          reservation.risk.toFixed(),
          reservation.exposure.toFixed(),
          reservation.margin.toFixed(),
        );
        await tx.tradingRiskReservation.update({
          where: { id: reservation.id },
          data: { ...capacity, kind: "POSITION" },
        });
        const filled = result.state.positions.find((row) => row.id === event.targetId);
        if (filled) filled.margin = capacity.margin;
      } else
        await tx.tradingRiskReservation.update({
          where: { id: reservation.id },
          data: { status: "RELEASED", risk: "0", exposure: "0", margin: "0" },
        });
      const receipt = await tx.simulationMarketReceipt.create({
        data: {
          accountId,
          ownerUserId: account.ownerUserId,
          targetId: event.targetId,
          type: event.type,
          originEffectId: event.originEffectId,
          mandateId: event.mandateId,
          bookRevision: book.revision + 1,
          event,
        },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: account.ownerUserId,
          accountId,
          mode: "SIMULATION",
          effectId: event.originEffectId,
          goalId: event.goalId,
          mandateId: event.mandateId,
          planVersion: event.planVersion,
          event: `SIMULATION_${event.type}`,
          entry: { ...event, observationId: receipt.id, bookRevision: book.revision + 1 },
        },
      });
      await tx.tradingMissionWake.upsert({
        where: { wakeKey: `simulation:${receipt.id}` },
        create: {
          mandateId: event.mandateId,
          wakeKey: `simulation:${receipt.id}`,
          kind: "ACCOUNT_EVENT",
          dueAt: now,
        },
        update: {},
      });
    }
    state = result.state;
    events.push(...result.events);
  };
  // Expiry is deterministic even during disconnection, downtime, or absence of a quote.
  await observe();
  const existing = await tx.simulationMarketCursor.findMany({ where: { accountId }, take: 1001 });
  if (existing.length > 1000 || existing.some((row) => row.ownerUserId !== account.ownerUserId))
    throw new Error("Simulation quote cache scope/capacity mismatch");
  const watermarks = new Map(existing.map((row) => [row.instrumentId, row.sourceTime.getTime()]));
  const latest = new Map<string, BrokerQuote>();
  for (const raw of quotes) {
    const quote = BrokerQuoteSchema.parse(raw);
    if (quote.accountId !== accountId) throw new Error("Simulation quote identity mismatch");
    if (!active.has(quote.instrumentId)) continue;
    if (
      ![...state.positions, ...state.orders].some(
        (row) => row.instrumentId === quote.instrumentId && row.brokerSymbol === quote.brokerSymbol,
      )
    )
      continue;
    const age = now.getTime() - Date.parse(quote.sourceTime),
      receivedAge = now.getTime() - Date.parse(quote.receivedAt);
    if (age < -2000 || age > 15000 || receivedAge < -2000 || receivedAge > 15000) continue;
    const cursor = watermarks.get(quote.instrumentId);
    if (cursor !== undefined && cursor >= Date.parse(quote.sourceTime)) continue;
    await observe(quote);
    watermarks.set(quote.instrumentId, Date.parse(quote.sourceTime));
    latest.set(quote.instrumentId, quote);
  }
  // Persist one latest quote per instrument per flush, not every high-frequency tick.
  for (const quote of latest.values()) {
    await tx.simulationMarketCursor.upsert({
      where: { accountId_instrumentId: { accountId, instrumentId: quote.instrumentId } },
      create: {
        accountId,
        instrumentId: quote.instrumentId,
        ownerUserId: account.ownerUserId,
        sourceTime: new Date(quote.sourceTime),
        quote,
      },
      update: { sourceTime: new Date(quote.sourceTime), quote },
    });
  }
  if (events.length)
    await tx.simulationBook.update({
      where: { accountId },
      data: { state, revision: { increment: 1 }, nextExpiryAt: nextSimulationExpiry(state) },
    });
  const remaining = [
    ...new Set([...state.positions, ...state.orders].map((row) => row.instrumentId)),
  ];
  await tx.simulationMarketCursor.deleteMany({
    where: { accountId, instrumentId: { notIn: remaining } },
  });
  // Pure price telemetry does not enqueue an agent turn. Only logical outcomes/limits do.
  await observeSimulationPerformance(
    tx,
    accountId,
    account.ownerUserId,
    state,
    book.revision + (events.length ? 1 : 0),
    now,
  );
}

async function observeSimulationPerformance(
  tx: Prisma.TransactionClient,
  accountId: string,
  owner: string,
  state: SimulationBookState,
  bookRevision: number,
  now: Date,
) {
  const cursors = await tx.simulationMarketCursor.findMany({
    where: { accountId, ownerUserId: owner },
    take: 1001,
  });
  if (cursors.length > 1000) throw new Error("Simulation quote cache capacity exceeded");
  let value: ReturnType<typeof valueSimulationBook> | null = null;
  try {
    value = valueSimulationBook(
      state,
      cursors.map((row) => BrokerQuoteSchema.parse(row.quote)),
      now,
    );
  } catch {
    /* Missing/stale portfolio quotes cannot certify risk or target progress. */
  }
  const mandates = await tx.tradingMandate.findMany({
    where: { accountId, ownerUserId: owner, mode: "SIMULATION", approvedAt: { not: null } },
    take: 1001,
  });
  if (mandates.length > 1000) throw new Error("Simulation mandate capacity exceeded");
  const reservations = await tx.tradingRiskReservation.findMany({
    where: {
      accountId,
      mode: "SIMULATION",
      status: { in: ["RESERVED", "COMMITTED", "UNCERTAIN"] },
    },
    take: 10001,
  });
  if (reservations.length > 10000) throw new Error("Simulation reservation capacity exceeded");
  const guard = await tx.accountRiskGuardrail.findUnique({
    where: { accountId_mode: { accountId, mode: "SIMULATION" } },
  });
  let accountFrozen = guard?.frozen ?? false;
  if (guard) {
    const limits = AccountRiskGuardrailsSchema.parse(guard.limits);
    const sum = (key: "risk" | "exposure", pending = false) =>
      reservations
        .filter((row) => !pending || row.kind === "PENDING")
        .reduce((total, row) => total + u(row[key].toFixed()), 0n);
    if (
      !guard.frozen &&
      (sum("risk") > u(limits.maxReservedRisk) ||
        sum("exposure") > u(limits.maxExposure) ||
        sum("exposure", true) > u(limits.maxPendingExposure))
    ) {
      accountFrozen = true;
      await tx.accountRiskGuardrail.update({
        where: { id: guard.id },
        data: {
          frozen: true,
          revision: { increment: 1 },
          limits: { ...limits, frozen: true, revision: guard.revision + 1 },
        },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: owner,
          accountId,
          mode: "SIMULATION",
          event: "SIMULATION_ACCOUNT_RISK_BREACH",
          entry: { version: 1, bookRevision },
        },
      });
    }
  }
  for (const mandate of mandates) {
    const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
    const performance = state.performance.find((row) => row.mandateId === mandate.id);
    const unrealized = value?.unrealized.get(mandate.id) ?? 0n;
    const pnl = u(performance?.realized ?? "0") + unrealized;
    const daily =
      u(performance?.day === now.toISOString().slice(0, 10) ? performance.dailyRealized : "0") +
      unrealized;
    const own = reservations.filter((row) => row.mandateId === mandate.id);
    const openRisk = own.reduce((total, row) => total + u(row.risk.toFixed()), 0n);
    let status = mandate.status;
    if (status === "ACTIVE") {
      if (mandate.expiresAt <= now) status = "EXPIRED";
      else if (accountFrozen) status = "PAUSED";
      else if (!value && state.positions.some((row) => row.mandateId === mandate.id))
        status = "NEEDS_ATTENTION";
      else if (
        value &&
        (pnl <= -u(envelope.maxMissionLoss) ||
          (pnl < 0n ? -pnl : 0n) + openRisk > u(envelope.maxMissionLoss) ||
          (envelope.maxDailyLoss !== null &&
            (daily <= -u(envelope.maxDailyLoss) ||
              (daily < 0n ? -daily : 0n) + openRisk > u(envelope.maxDailyLoss))) ||
          openRisk > u(envelope.maxOpenRisk) ||
          own.some((row) => u(row.risk.toFixed()) > u(envelope.maxRiskPerTrade)))
      )
        status = "RISK_STOPPED";
      else if (value) {
        const goal = TradingGoalInputSchema.parse(
          (await tx.tradingGoal.findUniqueOrThrow({ where: { id: mandate.goalId } })).definition,
        );
        if (goal.targetProfit !== null && pnl >= u(goal.targetProfit)) status = "TARGET_REACHED";
      }
    }
    const changed = status !== mandate.status;
    await tx.tradingMandate.update({
      where: { id: mandate.id },
      data: {
        ...(value
          ? {
              missionPnl: d(pnl),
              dailyPnl: d(daily),
              observedAt: now,
              observedState: { version: 1, source: "simulation-market-v1", bookRevision },
            }
          : {}),
        ...(changed ? { status, revision: { increment: 1 } } : {}),
      },
    });
    if (changed) {
      const key = `simulation:mission:${mandate.id}:${mandate.revision + 1}:${status}`;
      await tx.financialJournal.create({
        data: {
          ownerUserId: owner,
          accountId,
          mode: "SIMULATION",
          goalId: mandate.goalId,
          mandateId: mandate.id,
          event: `MISSION_${status}`,
          entry: {
            version: 1,
            bookRevision,
            missionPnl: value ? d(pnl) : null,
            openRisk: d(openRisk),
          },
        },
      });
      await tx.tradingMissionWake.upsert({
        where: { wakeKey: key },
        create: { mandateId: mandate.id, wakeKey: key, kind: "ACCOUNT_EVENT", dueAt: now },
        update: {},
      });
    }
  }
}

export async function enqueueSimulationExpiries(
  prisma: PrismaClient,
  jobs: JobPublisher,
  accountId?: string,
  now = new Date(),
) {
  const books = await prisma.simulationBook.findMany({
    where: {
      ...(accountId ? { accountId } : {}),
      nextExpiryAt: accountId ? { not: null } : { lte: new Date(now.getTime() + 60000) },
    },
    take: 32,
    orderBy: { nextExpiryAt: "asc" },
  });
  for (const book of books)
    if (book.nextExpiryAt)
      await jobs.enqueue(simulationExpiryJob(book.accountId, book.nextExpiryAt));
}

export async function expireSimulationAccount(
  prisma: PrismaClient,
  accountId: string,
  scheduledFor: string,
  now = new Date(),
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${accountId} FOR UPDATE`;
    const book = await tx.simulationBook.findUnique({ where: { accountId } });
    if (
      !book?.nextExpiryAt ||
      book.nextExpiryAt > now ||
      book.nextExpiryAt.getTime() !== Date.parse(scheduledFor)
    )
      return;
    await observeSimulationAccount(tx, accountId, [], now);
  });
}
