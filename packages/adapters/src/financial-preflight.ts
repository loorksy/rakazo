import type { FinancialAction } from "@rakazo/contracts";
import {
  BrokerQuoteSchema,
  FinancialActionSchema,
  FinancialRiskFactsSchema,
  SimulationBookStateSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { ChartActor } from "./cloud-charts.js";
import { SimulationBroker } from "./simulation-broker.js";
import { requestBrokerRead } from "./trading-connections.js";

/** Provider-owned facts and virtual accounting, never model-supplied numeric claims. */
export async function financialPreflight(
  prisma: PrismaClient,
  actor: ChartActor,
  action: FinancialAction,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const book =
    action.mode === "SIMULATION"
      ? await prisma.simulationBook.findFirst({
          where: { accountId: action.accountId, ownerUserId: actor.ownerUserId },
        })
      : null;
  const state = book ? SimulationBookStateSchema.parse(book.state) : null;
  let providerAction = action;
  if (action.mode === "SIMULATION" && action.operation === "MODIFY_ORDER") {
    const target = state?.orders.find(
      (row) =>
        row.id === action.orderId &&
        row.instrumentId === action.instrumentId &&
        row.brokerSymbol === action.brokerSymbol,
    );
    if (!target) throw new Error("Simulation pending target unavailable");
    // Ask the broker for entry margin evidence, never a mutation against a synthetic order ID.
    providerAction = FinancialActionSchema.parse({
      version: 1,
      mode: action.mode,
      provider: action.provider,
      accountId: action.accountId,
      instrumentId: action.instrumentId,
      brokerSymbol: action.brokerSymbol,
      operation: "OPEN",
      side: target.side,
      orderType: target.orderType,
      volume: action.volume,
      price: action.price,
      stopLimitPrice: null,
      stopLoss: action.stopLoss,
      takeProfit: action.takeProfit,
      expiresAt: action.expiresAt,
      fillingMode: null,
    });
  }
  const facts = FinancialRiskFactsSchema.parse(
    await requestBrokerRead(
      prisma,
      actor.ownerUserId,
      {
        operation: "preflight",
        accountId: action.accountId,
        instrumentId: action.instrumentId,
        action: providerAction,
      },
      signal,
    ),
  );
  if (action.mode !== "SIMULATION") return facts;
  const instruments = [
    ...new Set(state?.positions.map((position) => position.instrumentId) ?? []),
  ].filter((id) => id !== action.instrumentId);
  const quotes = [];
  // Bounded concurrency on the existing account-scoped provider session/read queue.
  for (let index = 0; index < instruments.length; index += 4) {
    signal?.throwIfAborted();
    quotes.push(
      ...(await Promise.all(
        instruments
          .slice(index, index + 4)
          .map(async (instrumentId) =>
            BrokerQuoteSchema.parse(
              await requestBrokerRead(
                prisma,
                actor.ownerUserId,
                { operation: "quote", accountId: action.accountId, instrumentId },
                signal,
              ),
            ),
          ),
      )),
    );
  }
  signal?.throwIfAborted();
  return new SimulationBroker(prisma).preflight(actor, facts, quotes);
}
