import type { FinancialAction } from "@rakazo/contracts";
import {
  BrokerQuoteSchema,
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
  const facts = FinancialRiskFactsSchema.parse(
    await requestBrokerRead(
      prisma,
      actor.ownerUserId,
      {
        operation: "preflight",
        accountId: action.accountId,
        instrumentId: action.instrumentId,
        action,
      },
      signal,
    ),
  );
  if (action.mode !== "SIMULATION") return facts;
  const book = await prisma.simulationBook.findFirst({
    where: { accountId: action.accountId, ownerUserId: actor.ownerUserId },
  });
  const state = book ? SimulationBookStateSchema.parse(book.state) : null;
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
