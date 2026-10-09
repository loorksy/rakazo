import type {
  BrokerQuote,
  FinancialAction,
  FinancialEffectOutcome,
  FinancialRiskFacts,
  SimulationBookState,
  SimulationPosition,
} from "@rakazo/contracts";
import {
  BrokerQuoteSchema,
  FinancialActionSchema,
  FinancialRiskFactsSchema,
  SimulationBookStateSchema,
  SimulationPositionSchema,
} from "@rakazo/contracts";
import {
  financialDecimal as d,
  FINANCIAL_SCALE,
  financialCeil,
  financialUnits as u,
} from "./financial-decimal.js";

export interface SimulationAttribution {
  effectId: string;
  mandateId: string;
  goalId: string;
  planVersion: number;
}
function requireSimulation(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function volume(value: string, facts: FinancialRiskFacts) {
  requireSimulation(
    u(value) >= u(facts.minVolume) &&
      u(value) <= u(facts.maxVolume) &&
      u(value) % u(facts.volumeStep) === 0n,
    "SIMULATION_INVALID_VOLUME",
  );
}
function freshQuote(quote: BrokerQuote, now: Date) {
  for (const time of [quote.sourceTime, quote.receivedAt]) {
    const age = now.getTime() - Date.parse(time);
    requireSimulation(
      Number.isFinite(age) && age >= -2000 && age <= 15000,
      "SIMULATION_STALE_QUOTE",
    );
  }
}
export function simulationPnl(
  position: SimulationPosition,
  price: string,
  amount = position.volume,
): string {
  const change =
    position.side === "BUY" ? u(price) - u(position.entry) : u(position.entry) - u(price);
  const numerator = change * u(amount) * u(position.contractSize);
  const denominator = FINANCIAL_SCALE * FINANCIAL_SCALE;
  return d(numerator >= 0n ? numerator / denominator : -financialCeil(-numerator, denominator));
}
function realize(state: SimulationBookState, position: SimulationPosition, pnl: string, now: Date) {
  state.balance = d(u(state.balance) + u(pnl));
  const day = now.toISOString().slice(0, 10);
  let record = state.performance.find((row) => row.mandateId === position.mandateId);
  if (!record) {
    record = { mandateId: position.mandateId, realized: "0", day, dailyRealized: "0" };
    state.performance.push(record);
  }
  record.realized = d(u(record.realized) + u(pnl));
  record.dailyRealized = d((record.day === day ? u(record.dailyRealized) : 0n) + u(pnl));
  record.day = day;
}

/** Deterministic fake execution provider; it has no filesystem, credentials or network port. */
export function applySimulationAction(input: {
  state: SimulationBookState;
  action: FinancialAction;
  attribution: SimulationAttribution;
  facts: FinancialRiskFacts;
  now: Date;
}): { state: SimulationBookState; outcome: FinancialEffectOutcome; releasedEffectIds: string[] } {
  const state = SimulationBookStateSchema.parse(input.state);
  const action = FinancialActionSchema.parse(input.action);
  const facts = FinancialRiskFactsSchema.parse(input.facts);
  const { attribution, now } = input;
  requireSimulation(
    action.mode === "SIMULATION" &&
      action.accountId === state.accountId &&
      facts.accountId === state.accountId &&
      state.currency === facts.currency &&
      facts.instrumentId === action.instrumentId &&
      facts.brokerSymbol === action.brokerSymbol &&
      facts.quote.accountId === state.accountId &&
      facts.quote.instrumentId === action.instrumentId &&
      facts.quote.brokerSymbol === action.brokerSymbol &&
      facts.quote.provider === action.provider,
    "SIMULATION_IDENTITY_MISMATCH",
  );
  requireSimulation(
    Number.isFinite(now.getTime()) &&
      facts.connected &&
      facts.tradingAllowed &&
      facts.symbolTradingAllowed,
    "SIMULATION_ACCOUNT_UNAVAILABLE",
  );
  freshQuote(facts.quote, now);
  const time = now.toISOString();
  const id = `sim_${attribution.effectId}`;
  const releasedEffectIds: string[] = [];
  if (action.operation === "OPEN") {
    requireSimulation(action.fillingMode === null, "SIMULATION_FILLING_MODE_UNSUPPORTED");
    requireSimulation(
      facts.accountMode === "HEDGING" &&
        action.orderType !== "STOP_LIMIT" &&
        facts.orderTypes.includes(action.orderType),
      "SIMULATION_UNSUPPORTED_ORDER_TYPE",
    );
    requireSimulation(
      facts.contractSize !== null &&
        facts.profitCurrency === facts.currency &&
        facts.proposedMargin !== null,
      "SIMULATION_UNKNOWN_PRICING",
    );
    requireSimulation(
      ![...state.positions, ...state.orders].some(
        (item) => item.originEffectId === attribution.effectId,
      ),
      "SIMULATION_DUPLICATE_ACTION",
    );
    volume(action.volume, facts);
    const position = SimulationPositionSchema.parse({
      id,
      originEffectId: attribution.effectId,
      mandateId: attribution.mandateId,
      goalId: attribution.goalId,
      planVersion: attribution.planVersion,
      instrumentId: action.instrumentId,
      brokerSymbol: action.brokerSymbol,
      side: action.side,
      volume: action.volume,
      entry: action.price ?? (action.side === "BUY" ? facts.quote.ask : facts.quote.bid),
      stopLoss: action.stopLoss,
      takeProfit: action.takeProfit,
      contractSize: facts.contractSize,
      margin: facts.proposedMargin,
      createdAt: time,
      updatedAt: time,
    });
    requireSimulation(position.stopLoss !== null, "SIMULATION_UNBOUNDED_LOSS");
    if (action.orderType === "MARKET") state.positions.push(position);
    else {
      requireSimulation(
        action.expiresAt !== null && Date.parse(action.expiresAt) > now.getTime(),
        "SIMULATION_PENDING_EXPIRY_REQUIRED",
      );
      state.orders.push({ ...position, orderType: action.orderType, expiresAt: action.expiresAt });
    }
  } else {
    const orderAction = action.operation === "CANCEL_ORDER" || action.operation === "MODIFY_ORDER";
    const targetId = orderAction ? action.orderId : action.positionId;
    const target = (orderAction ? state.orders : state.positions).find(
      (item) => item.id === targetId,
    );
    requireSimulation(
      !!target &&
        target.mandateId === attribution.mandateId &&
        target.instrumentId === action.instrumentId &&
        target.brokerSymbol === action.brokerSymbol,
      "SIMULATION_TARGET_UNAVAILABLE",
    );
    if (action.operation === "CANCEL_ORDER") {
      state.orders = state.orders.filter((item) => item.id !== target.id);
      releasedEffectIds.push(target.originEffectId);
    } else if (action.operation === "CLOSE_POSITION") {
      const amount = action.volume ?? target.volume;
      if (action.volume !== null)
        requireSimulation(facts.partialClose, "SIMULATION_PARTIAL_CLOSE_UNSUPPORTED");
      volume(amount, facts);
      requireSimulation(u(amount) <= u(target.volume), "SIMULATION_INVALID_PARTIAL_CLOSE");
      const remaining = u(target.volume) - u(amount);
      if (remaining > 0n) volume(d(remaining), facts);
      realize(
        state,
        target,
        simulationPnl(target, target.side === "BUY" ? facts.quote.bid : facts.quote.ask, amount),
        now,
      );
      if (remaining === 0n) {
        state.positions = state.positions.filter((item) => item.id !== target.id);
        releasedEffectIds.push(target.originEffectId);
      } else {
        target.margin = d(financialCeil(u(target.margin) * remaining, u(target.volume)));
        target.volume = d(remaining);
        target.updatedAt = time;
      }
    } else if (action.operation === "MODIFY_PROTECTION") {
      requireSimulation(action.stopLoss !== null, "SIMULATION_UNBOUNDED_LOSS");
      target.stopLoss = action.stopLoss;
      target.takeProfit = action.takeProfit;
      target.updatedAt = time;
    } else {
      const order = state.orders.find((item) => item.id === target.id);
      requireSimulation(
        !!order &&
          action.expiresAt !== null &&
          Date.parse(action.expiresAt) > now.getTime() &&
          action.stopLimitPrice === null &&
          facts.proposedMargin !== null,
        "SIMULATION_INVALID_ORDER_CHANGE",
      );
      volume(action.volume, facts);
      Object.assign(order, {
        volume: action.volume,
        entry: action.price,
        stopLoss: action.stopLoss,
        takeProfit: action.takeProfit,
        expiresAt: action.expiresAt,
        margin: facts.proposedMargin,
        updatedAt: time,
      });
    }
  }
  return {
    state: SimulationBookStateSchema.parse(state),
    outcome: { version: 1, status: "SUCCEEDED", providerReference: id, code: null },
    releasedEffectIds,
  };
}

/** Account valuation needs fresh quotes for every open position; it never invents another symbol's price. */
export function valueSimulationBook(raw: SimulationBookState, quotes: BrokerQuote[], now: Date) {
  const state = SimulationBookStateSchema.parse(raw);
  const prices = BrokerQuoteSchema.array().max(1000).parse(quotes);
  const unrealized = new Map<string, bigint>();
  let pnl = 0n;
  let margin = 0n;
  for (const position of state.positions) {
    const quote = prices.find(
      (item) =>
        item.accountId === state.accountId &&
        item.instrumentId === position.instrumentId &&
        item.brokerSymbol === position.brokerSymbol,
    );
    requireSimulation(!!quote, "SIMULATION_QUOTE_REQUIRED");
    freshQuote(quote, now);
    const result = u(simulationPnl(position, position.side === "BUY" ? quote.bid : quote.ask));
    pnl += result;
    margin += u(position.margin);
    unrealized.set(position.mandateId, (unrealized.get(position.mandateId) ?? 0n) + result);
  }
  const equity = u(state.balance) + pnl;
  return { equity: d(equity), margin: d(margin), freeMargin: d(equity - margin), unrealized };
}
