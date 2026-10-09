import type { FinancialAction, FinancialRiskFacts } from "@rakazo/contracts";
import {
  FinancialActionSchema,
  FinancialEffectContextSchema,
  FinancialEffectOutcomeSchema,
  FinancialRiskTargetSchema,
  SimulationBookStateSchema,
} from "@rakazo/contracts";
import { assessAttributedFinancialAction } from "@rakazo/core";
import { financialActionFingerprint } from "@rakazo/core/node/financial-action";
import type { Prisma } from "@rakazo/db";

/** Protected provider attribution, not a model-supplied position/order snapshot. */
export async function financialTarget(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  mandateId: string,
  action: FinancialAction,
  facts: FinancialRiskFacts,
) {
  if (action.operation === "OPEN") return null;
  if (action.mode !== "SIMULATION") throw new Error("Verified live target attribution required");
  const book = await tx.simulationBook.findUnique({ where: { accountId: action.accountId } });
  if (!book || book.ownerUserId !== ownerUserId || book.revision !== facts.simulationRevision)
    throw new Error("Current simulation target revision required");
  const state = SimulationBookStateSchema.parse(book.state);
  const orderAction = action.operation === "MODIFY_ORDER" || action.operation === "CANCEL_ORDER";
  const id = orderAction ? action.orderId : action.positionId;
  const position = (orderAction ? state.orders : state.positions).find((row) => row.id === id);
  if (
    !position ||
    position.mandateId !== mandateId ||
    position.instrumentId !== action.instrumentId ||
    position.brokerSymbol !== action.brokerSymbol
  )
    throw new Error("Target outside attributed mandate");
  const origin = await tx.externalEffect.findUniqueOrThrow({
    where: { id: position.originEffectId },
  });
  const context = FinancialEffectContextSchema.parse(origin.financialContext);
  const accepted = await tx.simulationExecution.findUnique({ where: { effectId: origin.id } });
  const originAction = FinancialActionSchema.parse(origin.request);
  const receipt = accepted ? FinancialEffectOutcomeSchema.parse(accepted.outcome) : null;
  const reservation = await tx.tradingRiskReservation.findUniqueOrThrow({
    where: { effectId: origin.id },
  });
  if (
    context.version !== 2 ||
    context.ownerUserId !== ownerUserId ||
    context.authorizationId !== mandateId ||
    context.accountId !== action.accountId ||
    context.mode !== "SIMULATION" ||
    originAction.operation !== "OPEN" ||
    originAction.mode !== "SIMULATION" ||
    originAction.accountId !== action.accountId ||
    originAction.instrumentId !== position.instrumentId ||
    originAction.brokerSymbol !== position.brokerSymbol ||
    originAction.side !== position.side ||
    context.actionFingerprint !== financialActionFingerprint(originAction) ||
    reservation.actionFingerprint !== context.actionFingerprint ||
    !accepted ||
    accepted.accountId !== action.accountId ||
    accepted.ownerUserId !== ownerUserId ||
    accepted.mandateId !== mandateId ||
    accepted.actionFingerprint !== context.actionFingerprint ||
    receipt?.status !== "SUCCEEDED" ||
    receipt.providerReference !== id ||
    origin.status !== "completed" ||
    reservation.status !== "COMMITTED" ||
    reservation.mandateId !== mandateId ||
    reservation.accountId !== action.accountId ||
    reservation.mode !== "SIMULATION" ||
    reservation.ownerUserId !== ownerUserId ||
    reservation.providerReference !== id ||
    reservation.kind !== (orderAction ? "PENDING" : "POSITION")
  )
    throw new Error("Confirmed target origin required");
  return {
    reservation,
    target: FinancialRiskTargetSchema.parse({
      id,
      kind: orderAction ? "ORDER" : "POSITION",
      orderType: orderAction ? state.orders.find((row) => row.id === id)?.orderType : null,
      instrumentId: position.instrumentId,
      brokerSymbol: position.brokerSymbol,
      side: position.side,
      volume: position.volume,
      entry: position.entry,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      attributed: true,
      drifted: false,
      observedAt: facts.observedAt,
    }),
  };
}

/** Maps protected database attribution into the shared deterministic risk engine. */
export function attributedFinancialAssessment(
  input: Omit<Parameters<typeof assessAttributedFinancialAction>[0], "target" | "reservation"> & {
    attribution: Awaited<ReturnType<typeof financialTarget>>;
  },
) {
  const row = input.attribution?.reservation;
  return assessAttributedFinancialAction({
    ...input,
    target: input.attribution?.target,
    reservation: row
      ? { risk: row.risk.toFixed(), exposure: row.exposure.toFixed(), margin: row.margin.toFixed() }
      : undefined,
  });
}
