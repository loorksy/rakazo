import type {
  FinancialAction,
  FinancialRiskFacts,
  FinancialRiskState,
  FinancialRiskTarget,
  TradingMandateEnvelope,
} from "@rakazo/contracts";
import {
  FinancialActionSchema,
  FinancialRiskFactsSchema,
  FinancialRiskStateSchema,
  FinancialRiskTargetSchema,
  TradingDecimalSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import {
  FINANCIAL_SCALE,
  financialCeil,
  financialDecimal,
  financialUnits as u,
} from "./financial-decimal.js";

export type FinancialRiskAssessment =
  | { decision: "DENY"; code: string }
  | {
      decision: "ALLOW";
      calculationVersion: "stop-loss-v1";
      riskBefore: string;
      riskAfter: string;
      incrementalRisk: string;
      notional: string;
      margin: string;
      classification: "REDUCES_RISK" | "SAME_RISK" | "INCREASES_RISK";
    };
class RiskFailure extends Error {}
/** Forward risk and original-entry loss accounting remain distinct, both enforced deterministically. */
export function assessAttributedFinancialAction(input: {
  action: FinancialAction;
  envelope: TradingMandateEnvelope;
  facts: FinancialRiskFacts;
  state: FinancialRiskState;
  now: Date;
  target?: FinancialRiskTarget;
  reservation?: { risk: string; exposure: string; margin: string };
}): {
  assessment: FinancialRiskAssessment;
  settlement: { risk: string; exposure: string; margin: string } | null;
} {
  try {
    const assessment = assessFinancialAction(input);
    if (assessment.decision !== "ALLOW" || input.action.operation === "OPEN")
      return { assessment, settlement: null };
    const { action, envelope, facts, state, target, reservation } = input;
    const deny = (code: string) => ({
      assessment: { decision: "DENY" as const, code },
      settlement: null,
    });
    if (!target || !reservation) return deny("MANAGEMENT_ATTRIBUTION_REQUIRED");
    for (const value of Object.values(reservation)) TradingDecimalSchema.parse(value);
    let volume = u(target.volume),
      entry = target.entry,
      stop = target.stopLoss;
    let margin = u(reservation.margin);
    if (
      action.operation === "CANCEL_ORDER" ||
      (action.operation === "CLOSE_POSITION" && action.volume === null)
    ) {
      volume = 0n;
      margin = 0n;
    } else if (action.operation === "CLOSE_POSITION") {
      volume -= u(action.volume ?? target.volume);
      margin = financialCeil(margin * volume, u(target.volume));
    } else if (action.operation === "MODIFY_PROTECTION") stop = action.stopLoss;
    else {
      volume = u(action.volume);
      entry = action.price;
      stop = action.stopLoss;
      if (facts.proposedMargin === null) return deny("UNKNOWN_MARGIN");
      margin = u(facts.proposedMargin);
    }
    if (volume > 0n && stop === null) return deny("UNBOUNDED_LOSS");
    let risk = 0n;
    if (volume > 0n && stop !== null) {
      risk =
        protectedRisk(target.side, entry, stop, financialDecimal(volume), facts) +
        u(envelope.costReservePerTrade);
    }
    let exposure = 0n;
    if (volume > 0n) {
      if (action.operation === "MODIFY_ORDER") {
        if (facts.contractSize === null || facts.profitCurrency !== facts.currency)
          return deny("UNKNOWN_ACCOUNT_NOTIONAL");
        exposure = financialCeil(
          u(entry) * u(facts.contractSize) * volume,
          FINANCIAL_SCALE * FINANCIAL_SCALE,
        );
      } else exposure = financialCeil(u(reservation.exposure) * volume, u(target.volume));
    }
    const delta = (after: bigint, before: bigint) => (after > before ? after - before : 0n);
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    const incrementalRisk = max(u(assessment.incrementalRisk), delta(risk, u(reservation.risk)));
    const incrementalExposure = max(
      u(assessment.notional),
      delta(exposure, u(reservation.exposure)),
    );
    const incrementalMargin = max(u(assessment.margin), delta(margin, u(reservation.margin)));
    if (incrementalRisk > 0n || incrementalExposure > 0n || incrementalMargin > 0n) {
      if (
        !state.missionActive ||
        state.accountFrozen ||
        Date.parse(envelope.expiresAt) <= input.now.getTime()
      )
        return deny("MISSION_NOT_ACTIVE");
      const loss = u(state.missionPnl) < 0n ? -u(state.missionPnl) : 0n;
      const dailyLoss = u(state.dailyPnl) < 0n ? -u(state.dailyPnl) : 0n;
      if (risk > u(envelope.maxRiskPerTrade)) return deny("PER_TRADE_RISK_LIMIT");
      if (loss + u(state.openRisk) + incrementalRisk > u(envelope.maxMissionLoss))
        return deny("MISSION_LOSS_LIMIT");
      if (
        envelope.maxDailyLoss !== null &&
        dailyLoss + u(state.openRisk) + incrementalRisk > u(envelope.maxDailyLoss)
      )
        return deny("DAILY_LOSS_LIMIT");
      if (u(state.openRisk) + incrementalRisk > u(envelope.maxOpenRisk))
        return deny("OPEN_RISK_LIMIT");
      if (u(state.openNotional) + incrementalExposure > u(envelope.maxNotional))
        return deny("NOTIONAL_LIMIT");
    }
    return {
      assessment: {
        ...assessment,
        incrementalRisk: financialDecimal(incrementalRisk),
        notional: financialDecimal(incrementalExposure),
        margin: financialDecimal(incrementalMargin),
        classification:
          incrementalRisk > 0n || incrementalExposure > 0n || incrementalMargin > 0n
            ? "INCREASES_RISK"
            : assessment.classification,
      },
      settlement: {
        risk: financialDecimal(risk),
        exposure: financialDecimal(exposure),
        margin: financialDecimal(margin),
      },
    };
  } catch {
    return {
      assessment: { decision: "DENY", code: "INVALID_RESERVATION_INPUT" },
      settlement: null,
    };
  }
}
function requireRisk(condition: boolean, code: string): asserts condition {
  if (!condition) throw new RiskFailure(code);
}
function fresh(timestamp: string, now: Date, maxAge = 15000) {
  const age = now.getTime() - Date.parse(timestamp);
  return age >= -2000 && age <= maxAge;
}
function validVolume(value: string, facts: FinancialRiskFacts) {
  const volume = u(value);
  requireRisk(
    volume >= u(facts.minVolume) &&
      volume <= u(facts.maxVolume) &&
      volume % u(facts.volumeStep) === 0n,
    "INVALID_VOLUME",
  );
}
function validPrice(value: string, facts: FinancialRiskFacts) {
  requireRisk(u(value) % u(facts.tickSize) === 0n, "INVALID_PRICE_PRECISION");
}
function protectedRisk(
  side: "BUY" | "SELL",
  entry: string,
  stop: string | null,
  volume: string,
  facts: FinancialRiskFacts,
) {
  requireRisk(stop !== null, "UNBOUNDED_LOSS");
  const distance = side === "BUY" ? u(entry) - u(stop) : u(stop) - u(entry);
  const bounded = distance > 0n ? distance : 0n;
  if (facts.lossTickValue !== null)
    return financialCeil(
      bounded * u(facts.lossTickValue) * u(volume),
      u(facts.tickSize) * FINANCIAL_SCALE,
    );
  requireRisk(
    facts.contractSize !== null && facts.profitCurrency === facts.currency,
    "UNKNOWN_CURRENCY_RISK",
  );
  return financialCeil(
    bounded * u(facts.contractSize) * u(volume),
    FINANCIAL_SCALE * FINANCIAL_SCALE,
  );
}
function protectivePrices(
  side: "BUY" | "SELL",
  entry: string,
  stop: string | null,
  take: string | null,
  facts: FinancialRiskFacts,
  newEntry: boolean,
  reference: "ENTRY" | "QUOTE" = "QUOTE",
) {
  requireRisk(stop !== null, "UNBOUNDED_LOSS");
  for (const value of [entry, stop, take]) if (value !== null) validPrice(value, facts);
  const point = FINANCIAL_SCALE / 10n ** BigInt(facts.digits);
  const minimum = BigInt(facts.stopsLevel) * point;
  const current =
    reference === "ENTRY" ? u(entry) : side === "BUY" ? u(facts.quote.bid) : u(facts.quote.ask);
  requireRisk(
    side === "BUY"
      ? current - u(stop) >= minimum && u(stop) < current
      : u(stop) - current >= minimum && u(stop) > current,
    "INVALID_STOP_DISTANCE",
  );
  if (newEntry)
    requireRisk(
      side === "BUY" ? u(stop) < u(entry) : u(stop) > u(entry),
      "INVALID_PROTECTION_DIRECTION",
    );
  if (take !== null)
    requireRisk(
      side === "BUY"
        ? u(take) - current >= minimum && u(take) > current
        : current - u(take) >= minimum && u(take) < current,
      "INVALID_TARGET_DISTANCE",
    );
}
/** Model-independent theoretical stop-loss risk; gaps/slippage can exceed a protective stop. */
export function assessFinancialAction(input: {
  action: FinancialAction;
  envelope: TradingMandateEnvelope;
  facts: FinancialRiskFacts;
  state: FinancialRiskState;
  target?: FinancialRiskTarget;
  now: Date;
}): FinancialRiskAssessment {
  try {
    const action = FinancialActionSchema.parse(input.action);
    const envelope = TradingMandateEnvelopeSchema.parse(input.envelope);
    const facts = FinancialRiskFactsSchema.parse(input.facts);
    const state = FinancialRiskStateSchema.parse(input.state);
    requireRisk(Number.isFinite(input.now.getTime()), "INVALID_CLOCK");
    requireRisk(
      action.accountId === envelope.accountId &&
        facts.accountId === action.accountId &&
        action.mode === envelope.mode &&
        action.instrumentId === facts.instrumentId &&
        action.brokerSymbol === facts.brokerSymbol &&
        facts.currency === envelope.currency,
      "IDENTITY_MISMATCH",
    );
    requireRisk(
      facts.quote.accountId === facts.accountId &&
        facts.quote.instrumentId === facts.instrumentId &&
        facts.quote.brokerSymbol === facts.brokerSymbol &&
        facts.quote.provider === action.provider,
      "QUOTE_IDENTITY_MISMATCH",
    );
    requireRisk(
      envelope.allowedInstruments.includes(action.instrumentId) &&
        envelope.allowedOperations.includes(action.operation),
      "OUTSIDE_MANDATE",
    );
    requireRisk(
      facts.connected && facts.tradingAllowed && facts.symbolTradingAllowed,
      "ACCOUNT_UNAVAILABLE",
    );
    requireRisk(
      fresh(facts.observedAt, input.now) &&
        fresh(facts.quote.sourceTime, input.now) &&
        fresh(facts.quote.receivedAt, input.now) &&
        fresh(facts.specificationObservedAt, input.now, 300000),
      "STALE_BROKER_STATE",
    );
    requireRisk(!state.unresolvedEffects, "UNRESOLVED_EFFECT");
    let reductionRequested = false;
    let before = 0n;
    let after = 0n;
    let notional = 0n;
    let margin = 0n;
    if (action.operation === "OPEN") {
      requireRisk(envelope.supervisionPositionId === null, "SUPERVISION_CANNOT_OPEN");
      requireRisk(facts.accountMode === "HEDGING", "AMBIGUOUS_NETTING_ATTRIBUTION");
      requireRisk(
        envelope.allowedOrderTypes.includes(action.orderType) &&
          facts.orderTypes.includes(action.orderType),
        "UNSUPPORTED_ORDER_TYPE",
      );
      requireRisk(action.orderType !== "STOP_LIMIT", "STOP_LIMIT_PREFLIGHT_REQUIRED");
      const existingExposure = [...facts.openPositions, ...facts.pendingOrders].filter(
        (item) => item.symbol === action.brokerSymbol,
      );
      requireRisk(
        !existingExposure.some((item) => item.side === action.side) ||
          envelope.riskIncreasePermissions.includes("ADD_EXPOSURE"),
        "ADDITIONAL_EXPOSURE_NOT_AUTHORIZED",
      );
      requireRisk(
        !existingExposure.some((item) => item.side !== action.side) ||
          envelope.riskIncreasePermissions.includes("HEDGE"),
        "HEDGE_NOT_AUTHORIZED",
      );
      validVolume(action.volume, facts);
      const entry = action.price ?? (action.side === "BUY" ? facts.quote.ask : facts.quote.bid);
      if (action.orderType !== "MARKET") {
        requireRisk(
          action.expiresAt !== null &&
            Date.parse(action.expiresAt) <= Date.parse(envelope.expiresAt) &&
            Date.parse(action.expiresAt) > input.now.getTime(),
          "PENDING_EXPIRY_REQUIRED",
        );
        const limit = action.orderType === "LIMIT";
        const correctSide =
          action.side === "BUY" ? u(entry) < u(facts.quote.ask) : u(entry) > u(facts.quote.bid);
        requireRisk(limit === correctSide, "INVALID_PENDING_PRICE");
      }
      protectivePrices(
        action.side,
        entry,
        action.stopLoss,
        action.takeProfit,
        facts,
        true,
        action.orderType === "MARKET" ? "QUOTE" : "ENTRY",
      );
      after =
        protectedRisk(action.side, entry, action.stopLoss, action.volume, facts) +
        u(envelope.costReservePerTrade);
      requireRisk(
        facts.contractSize !== null && facts.profitCurrency === facts.currency,
        "UNKNOWN_ACCOUNT_NOTIONAL",
      );
      notional = financialCeil(
        u(entry) * u(action.volume) * u(facts.contractSize),
        FINANCIAL_SCALE * FINANCIAL_SCALE,
      );
      requireRisk(facts.proposedMargin !== null, "UNKNOWN_MARGIN");
      margin = u(facts.proposedMargin);
      requireRisk(
        action.orderType === "MARKET"
          ? state.positions < envelope.maxConcurrentPositions
          : state.pendingOrders < envelope.maxPendingOrders,
        "EXPOSURE_COUNT_LIMIT",
      );
    } else {
      const target = FinancialRiskTargetSchema.parse(input.target);
      const id =
        action.operation === "CANCEL_ORDER" || action.operation === "MODIFY_ORDER"
          ? action.orderId
          : action.positionId;
      requireRisk(
        target.id === id &&
          target.instrumentId === action.instrumentId &&
          target.brokerSymbol === action.brokerSymbol &&
          target.attributed &&
          !target.drifted &&
          fresh(target.observedAt, input.now),
        "TARGET_OWNERSHIP_CHANGED",
      );
      const orderAction =
        action.operation === "CANCEL_ORDER" || action.operation === "MODIFY_ORDER";
      requireRisk(target.kind === (orderAction ? "ORDER" : "POSITION"), "TARGET_KIND_MISMATCH");
      if (envelope.supervisionPositionId !== null)
        requireRisk(
          orderAction
            ? envelope.supervisedOrderIds.includes(target.id)
            : target.id === envelope.supervisionPositionId,
          "OUTSIDE_SUPERVISION",
        );
      const entry =
        target.kind === "ORDER"
          ? target.entry
          : target.side === "BUY"
            ? facts.quote.bid
            : facts.quote.ask;
      // Full close/cancel safely reduces exposure even when old protection cannot be priced.
      const fullReduction =
        action.operation === "CANCEL_ORDER" ||
        (action.operation === "CLOSE_POSITION" && action.volume === null);
      reductionRequested = fullReduction;
      before =
        target.stopLoss === null && fullReduction
          ? 0n
          : protectedRisk(target.side, entry, target.stopLoss, target.volume, facts);
      if (action.operation === "CLOSE_POSITION") {
        if (action.volume !== null) {
          requireRisk(facts.partialClose, "PARTIAL_CLOSE_UNSUPPORTED");
          validVolume(action.volume, facts);
          const remaining = u(target.volume) - u(action.volume);
          requireRisk(remaining > 0n, "INVALID_PARTIAL_CLOSE");
          validVolume(financialDecimal(remaining), facts);
          after = financialCeil(before * remaining, u(target.volume));
          reductionRequested = true;
        }
      } else if (action.operation === "MODIFY_PROTECTION") {
        protectivePrices(target.side, entry, action.stopLoss, action.takeProfit, facts, false);
        after = protectedRisk(target.side, entry, action.stopLoss, target.volume, facts);
        const widens =
          target.stopLoss !== null &&
          action.stopLoss !== null &&
          (target.side === "BUY"
            ? u(action.stopLoss) < u(target.stopLoss)
            : u(action.stopLoss) > u(target.stopLoss));
        requireRisk(
          !widens || envelope.riskIncreasePermissions.includes("WIDEN_STOP"),
          "STOP_WIDENING_NOT_AUTHORIZED",
        );
        reductionRequested =
          target.stopLoss !== null &&
          action.stopLoss !== null &&
          (target.side === "BUY"
            ? u(action.stopLoss) > u(target.stopLoss)
            : u(action.stopLoss) < u(target.stopLoss));
      } else if (action.operation === "MODIFY_ORDER") {
        validVolume(action.volume, facts);
        requireRisk(
          u(action.volume) <= u(target.volume) ||
            envelope.riskIncreasePermissions.includes("INCREASE_PENDING_VOLUME"),
          "PENDING_INCREASE_NOT_AUTHORIZED",
        );
        requireRisk(
          action.expiresAt !== null &&
            Date.parse(action.expiresAt) <= Date.parse(envelope.expiresAt) &&
            Date.parse(action.expiresAt) > input.now.getTime(),
          "PENDING_EXPIRY_REQUIRED",
        );
        requireRisk(action.stopLimitPrice === null, "STOP_LIMIT_PREFLIGHT_REQUIRED");
        requireRisk(
          target.orderType !== null &&
            target.orderType !== "STOP_LIMIT" &&
            facts.orderTypes.includes(target.orderType) &&
            envelope.allowedOrderTypes.includes(target.orderType),
          "UNSUPPORTED_ORDER_TYPE",
        );
        const correctSide =
          target.side === "BUY"
            ? u(action.price) < u(facts.quote.ask)
            : u(action.price) > u(facts.quote.bid);
        requireRisk((target.orderType === "LIMIT") === correctSide, "INVALID_PENDING_PRICE");
        protectivePrices(
          target.side,
          action.price,
          action.stopLoss,
          action.takeProfit,
          facts,
          true,
          "ENTRY",
        );
        after = protectedRisk(target.side, action.price, action.stopLoss, action.volume, facts);
        requireRisk(
          facts.contractSize !== null && facts.profitCurrency === facts.currency,
          "UNKNOWN_ACCOUNT_NOTIONAL",
        );
        const nextNotional = financialCeil(
          u(action.price) * u(action.volume) * u(facts.contractSize),
          FINANCIAL_SCALE * FINANCIAL_SCALE,
        );
        const oldNotional = financialCeil(
          u(target.entry) * u(target.volume) * u(facts.contractSize),
          FINANCIAL_SCALE * FINANCIAL_SCALE,
        );
        notional = nextNotional > oldNotional ? nextNotional - oldNotional : 0n;
        if (after > before || notional > 0n) {
          requireRisk(facts.proposedMargin !== null, "UNKNOWN_MARGIN");
          margin = u(facts.proposedMargin);
        }
      }
    }
    const incremental = after > before ? after - before : 0n;
    if (incremental > 0n || notional > 0n || action.operation === "OPEN") {
      requireRisk(
        state.missionActive &&
          !state.accountFrozen &&
          Date.parse(envelope.expiresAt) > input.now.getTime(),
        "MISSION_NOT_ACTIVE",
      );
      const missionLoss = u(state.missionPnl) < 0n ? -u(state.missionPnl) : 0n;
      const dailyLoss = u(state.dailyPnl) < 0n ? -u(state.dailyPnl) : 0n;
      requireRisk(
        missionLoss < u(envelope.maxMissionLoss) &&
          missionLoss + u(state.openRisk) + incremental <= u(envelope.maxMissionLoss),
        "MISSION_LOSS_LIMIT",
      );
      if (envelope.maxDailyLoss !== null)
        requireRisk(
          dailyLoss + u(state.openRisk) + incremental <= u(envelope.maxDailyLoss),
          "DAILY_LOSS_LIMIT",
        );
      requireRisk(after <= u(envelope.maxRiskPerTrade), "PER_TRADE_RISK_LIMIT");
      requireRisk(u(state.openRisk) + incremental <= u(envelope.maxOpenRisk), "OPEN_RISK_LIMIT");
      requireRisk(u(state.openNotional) + notional <= u(envelope.maxNotional), "NOTIONAL_LIMIT");
      requireRisk(
        margin <= u(facts.freeMargin) &&
          (u(facts.margin) + margin) * 100n * FINANCIAL_SCALE <=
            u(facts.equity) * u(envelope.maxMarginUsagePercent),
        "MARGIN_LIMIT",
      );
    }
    return {
      decision: "ALLOW",
      calculationVersion: "stop-loss-v1",
      riskBefore: financialDecimal(before),
      riskAfter: financialDecimal(after),
      incrementalRisk: financialDecimal(incremental),
      notional: financialDecimal(notional),
      margin: financialDecimal(margin),
      classification:
        after > before || notional > 0n
          ? "INCREASES_RISK"
          : after < before || reductionRequested
            ? "REDUCES_RISK"
            : "SAME_RISK",
    };
  } catch (error) {
    return {
      decision: "DENY",
      code: error instanceof RiskFailure ? error.message : "INVALID_RISK_INPUT",
    };
  }
}
