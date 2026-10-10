import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "@rakazo/adapter-kit";
import { FinancialActionSchema } from "@rakazo/contracts";
import { z } from "zod";
import { brokerSdkNumber } from "./metaapi-normalize.js";

type TradeOptions = { clientId: string };
type OpenTrade = (
  symbol: string,
  volume: number,
  stopLoss: number | undefined,
  takeProfit: number | undefined,
  options: TradeOptions,
) => Promise<unknown>;
type PendingTrade = (
  symbol: string,
  volume: number,
  price: number,
  stopLoss: number | undefined,
  takeProfit: number | undefined,
  options: TradeOptions,
) => Promise<unknown>;

/** Audited subset of MetaApi 29.3.3. Missing methods mean unavailable capabilities. */
export interface MetaApiExecutionPort {
  createMarketBuyOrder?: OpenTrade;
  createMarketSellOrder?: OpenTrade;
  createLimitBuyOrder?: PendingTrade;
  createLimitSellOrder?: PendingTrade;
  createStopBuyOrder?: PendingTrade;
  createStopSellOrder?: PendingTrade;
  modifyPosition?: (id: string, stopLoss: number, takeProfit: number) => Promise<unknown>;
  closePosition?: (id: string, options: TradeOptions) => Promise<unknown>;
  closePositionPartially?: (id: string, volume: number, options: TradeOptions) => Promise<unknown>;
  cancelOrder?: (id: string) => Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOrders(): Promise<unknown>;
}

const unknown = (): ExecutionResult => ({
  status: "UNCERTAIN",
  providerReference: null,
  code: "PROVIDER_OUTCOME_UNKNOWN",
});
const Reference = z.string().min(1).max(128);
const acknowledgement = z.object({
  numericCode: z.number().int(),
  orderId: Reference.optional(),
  positionId: Reference.optional(),
});
// Codes are defined by MetaTrader's trade-server protocol. No broker text is forwarded.
const rejectionCodes = new Set([
  10004, 10006, 10013, 10014, 10015, 10016, 10017, 10018, 10019, 10020, 10021, 10022, 10024, 10026,
  10027, 10030, 10032, 10033, 10034, 10035,
]);

/** Never retries, including timeouts. Resolution uses positive provider evidence only. */
export class MetaApiExecutionAdapter implements ExecutionProvider {
  constructor(
    private readonly accountId: string,
    private readonly rpc: MetaApiExecutionPort,
  ) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const action = FinancialActionSchema.parse(request.action);
    if (
      action.mode !== "LIVE" ||
      action.accountId !== this.accountId ||
      action.provider !== "metaapi" ||
      !/^rz_[a-f0-9]{10}_[a-f0-9]{10}$/.test(request.clientId)
    )
      throw new Error("Invalid trusted execution identity");
    const unavailable = (): ExecutionResult => ({
      status: "FAILED",
      providerReference: null,
      code: "CAPABILITY_UNAVAILABLE",
    });
    let send: (() => Promise<unknown>) | undefined;
    const options = { clientId: request.clientId };
    if (action.operation === "OPEN") {
      // These optional semantics cannot be silently discarded by the SDK translation.
      if (action.expiresAt || action.fillingMode || action.orderType === "STOP_LIMIT")
        return unavailable();
      const stop = action.stopLoss === null ? undefined : brokerSdkNumber(action.stopLoss);
      const take = action.takeProfit === null ? undefined : brokerSdkNumber(action.takeProfit);
      const volume = brokerSdkNumber(action.volume);
      if (action.orderType === "MARKET") {
        const method =
          action.side === "BUY" ? this.rpc.createMarketBuyOrder : this.rpc.createMarketSellOrder;
        if (method)
          send = () => method.call(this.rpc, action.brokerSymbol, volume, stop, take, options);
      } else {
        const method =
          action.orderType === "LIMIT"
            ? action.side === "BUY"
              ? this.rpc.createLimitBuyOrder
              : this.rpc.createLimitSellOrder
            : action.side === "BUY"
              ? this.rpc.createStopBuyOrder
              : this.rpc.createStopSellOrder;
        if (method && action.price !== null)
          send = () =>
            method.call(
              this.rpc,
              action.brokerSymbol,
              volume,
              brokerSdkNumber(action.price!),
              stop,
              take,
              options,
            );
      }
    } else if (action.operation === "MODIFY_PROTECTION" && this.rpc.modifyPosition) {
      const method = this.rpc.modifyPosition;
      send = () =>
        method.call(
          this.rpc,
          action.positionId,
          action.stopLoss === null ? 0 : brokerSdkNumber(action.stopLoss),
          action.takeProfit === null ? 0 : brokerSdkNumber(action.takeProfit),
        );
    } else if (action.operation === "CANCEL_ORDER" && this.rpc.cancelOrder) {
      const method = this.rpc.cancelOrder;
      send = () => method.call(this.rpc, action.orderId);
    } else if (action.operation === "CLOSE_POSITION") {
      if (action.volume === null && this.rpc.closePosition) {
        const method = this.rpc.closePosition;
        send = () => method.call(this.rpc, action.positionId, options);
      } else if (action.volume !== null && this.rpc.closePositionPartially) {
        const method = this.rpc.closePositionPartially;
        const volume = brokerSdkNumber(action.volume);
        send = () => method.call(this.rpc, action.positionId, volume, options);
      }
    }
    // MODIFY_ORDER changes volume in the canonical action; SDK modifyOrder cannot honor it.
    if (!send) return unavailable();
    try {
      const parsed = acknowledgement.safeParse(await send());
      if (!parsed.success) return unknown();
      const { numericCode, positionId, orderId } = parsed.data;
      const reference = positionId ?? orderId ?? null;
      if (
        (numericCode === 10009 || (numericCode === 10008 && action.operation === "OPEN")) &&
        (action.operation !== "OPEN" || reference !== null)
      )
        return { status: "SUCCEEDED", providerReference: reference, code: "PROVIDER_ACKNOWLEDGED" };
      if (rejectionCodes.has(numericCode))
        return {
          status: "FAILED",
          providerReference: reference,
          code: `PROVIDER_REJECTED_${numericCode}`,
        };
      // DONE_PARTIAL, timeout, connection loss and unfamiliar codes require reconciliation.
      return unknown();
    } catch (error) {
      const rejected = z.object({ numericCode: z.number().int() }).safeParse(error);
      if (rejected.success && rejectionCodes.has(rejected.data.numericCode))
        return {
          status: "FAILED",
          providerReference: null,
          code: `PROVIDER_REJECTED_${rejected.data.numericCode}`,
        };
      return unknown();
    }
  }
  async reconcile(request: ExecutionRequest): Promise<ExecutionResult> {
    const action = FinancialActionSchema.parse(request.action);
    if (
      action.accountId !== this.accountId ||
      action.provider !== "metaapi" ||
      action.mode !== "LIVE"
    )
      throw new Error("Invalid reconciliation identity");
    // This SDK has no stable client reference for protection/cancel operations. Matching current
    // SL/TP or absence of a position is insufficient to attribute a previous mutation.
    if (action.operation !== "OPEN") return unknown();
    try {
      const rows = z
        .array(
          z.object({
            id: Reference,
            clientId: z.string().optional(),
            symbol: z.string(),
            type: z.string(),
            volume: z.number().finite().positive(),
          }),
        )
        .parse(
          action.orderType === "MARKET"
            ? await this.rpc.getPositions()
            : await this.rpc.getOrders(),
        );
      const matching = rows.filter((row) => row.clientId === request.clientId);
      if (matching.length !== 1) return unknown();
      const row = matching[0]!;
      const type =
        action.orderType === "MARKET"
          ? `POSITION_TYPE_${action.side}`
          : `ORDER_TYPE_${action.side}_${action.orderType}`;
      if (
        row.symbol !== action.brokerSymbol ||
        row.type !== type ||
        row.volume !== brokerSdkNumber(action.volume)
      )
        return unknown();
      return {
        status: "SUCCEEDED",
        providerReference: row.id,
        code: "PROVIDER_CLIENT_REFERENCE_CONFIRMED",
      };
    } catch {
      return unknown();
    }
  }
}
