import type { ExecutionRequest, ExecutionResult } from "@rakazo/adapter-kit";
import { TradingDecimalSchema } from "@rakazo/contracts";
import { z } from "zod";
import type { BrokerState } from "./broker-state.js";
import {
  BrokerOrderStateSchema,
  BrokerPositionStateSchema,
  remainingVolume,
} from "./broker-state.js";

export const ProviderAdmissionSchema = z.object({
  targetReservationId: z.string().nullable(),
  target: z.union([BrokerPositionStateSchema, BrokerOrderStateSchema]).nullable(),
  expectedEntry: TradingDecimalSchema.nullable(),
  settlement: z
    .object({
      risk: TradingDecimalSchema,
      exposure: TradingDecimalSchema,
      margin: TradingDecimalSchema,
    })
    .nullable(),
});
export type ProviderAdmission = z.infer<typeof ProviderAdmissionSchema>;

/** An acknowledgement and exact postcondition are both required to commit local attribution. */
export function confirmProviderMutation(
  request: ExecutionRequest,
  admission: ProviderAdmission,
  state: BrokerState,
  result: ExecutionResult,
) {
  const action = request.action;
  const uncertain = {
    outcome: {
      status: "UNCERTAIN" as const,
      providerReference: result.providerReference,
      code: "PROVIDER_POSTCONDITION_UNVERIFIED",
    },
    target: null,
  };
  if (result.status !== "SUCCEEDED") return { outcome: result, target: null };
  if (state.account.accountId !== action.accountId || state.account.accountMode !== "HEDGING")
    return uncertain;
  if (action.operation === "OPEN") {
    const matches = (action.orderType === "MARKET" ? state.positions : state.orders).filter(
      (row) => row.clientId === request.clientId,
    );
    if (matches.length !== 1) return uncertain;
    const target = matches[0]!;
    if (
      target.symbol !== action.brokerSymbol ||
      target.side !== action.side ||
      target.volume !== action.volume ||
      target.stopLoss !== action.stopLoss ||
      target.takeProfit !== action.takeProfit ||
      ("orderType" in target &&
        (target.orderType !== action.orderType ||
          target.expiresAt !== action.expiresAt ||
          target.stopLimitPrice !== action.stopLimitPrice)) ||
      ("entry" in target ? target.entry !== admission.expectedEntry : target.price !== action.price)
    )
      return uncertain;
    return { outcome: { ...result, providerReference: target.id }, target };
  }
  if (!admission.target) return uncertain;
  const orderAction = action.operation === "CANCEL_ORDER" || action.operation === "MODIFY_ORDER";
  const id = orderAction ? action.orderId : action.positionId;
  if (id !== admission.target.id || admission.target.symbol !== action.brokerSymbol)
    return uncertain;
  const target =
    (orderAction ? state.orders : state.positions).find((row) => row.id === id) ?? null;
  let expected: typeof target = admission.target;
  if (
    action.operation === "CANCEL_ORDER" ||
    (action.operation === "CLOSE_POSITION" && action.volume === null)
  )
    expected = null;
  else if (action.operation === "CLOSE_POSITION")
    expected = {
      ...admission.target,
      volume: remainingVolume(admission.target.volume, action.volume!),
    };
  else if (action.operation === "MODIFY_PROTECTION")
    expected = { ...admission.target, stopLoss: action.stopLoss, takeProfit: action.takeProfit };
  else if (action.operation === "MODIFY_ORDER") {
    if (!("price" in admission.target)) return uncertain;
    expected = {
      ...admission.target,
      volume: action.volume,
      price: action.price,
      stopLimitPrice: action.stopLimitPrice,
      expiresAt: action.expiresAt,
      stopLoss: action.stopLoss,
      takeProfit: action.takeProfit,
    };
  }
  if (JSON.stringify(target) !== JSON.stringify(expected)) return uncertain;
  return { outcome: { ...result, providerReference: id }, target };
}
