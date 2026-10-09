import type {
  AccountRiskGuardrails,
  FinancialAction,
  FinancialRiskFacts,
  TradingMandateEnvelope,
} from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  FinancialActionSchema,
  FinancialRiskAssessmentSchema,
  FinancialRiskFactsSchema,
  TradingDecimalSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { FINANCIAL_SCALE, financialUnits as u } from "./financial-decimal.js";
import type { FinancialRiskAssessment } from "./financial-risk.js";

export interface RiskCapacityReservation {
  mandateId: string;
  risk: string;
  exposure: string;
  margin: string;
  kind: string;
  status: string;
}

/** Shared by preview and atomic admission. Reservation facts are protected backend inputs. */
export function accountRiskCapacity(input: {
  mandateId: string;
  action: FinancialAction;
  envelope: TradingMandateEnvelope;
  limits: AccountRiskGuardrails;
  facts: FinancialRiskFacts;
  assessment: FinancialRiskAssessment;
  reservations: RiskCapacityReservation[];
}): string | null {
  try {
    const envelope = TradingMandateEnvelopeSchema.parse(input.envelope);
    const limits = AccountRiskGuardrailsSchema.parse(input.limits);
    const facts = FinancialRiskFactsSchema.parse(input.facts);
    const action = FinancialActionSchema.parse(input.action);
    const assessment = FinancialRiskAssessmentSchema.parse(input.assessment);
    if (assessment.decision !== "ALLOW") return assessment.code;
    if (
      limits.accountId !== facts.accountId ||
      envelope.accountId !== facts.accountId ||
      limits.mode !== envelope.mode ||
      action.accountId !== facts.accountId ||
      action.mode !== envelope.mode
    )
      return "CAPACITY_IDENTITY_MISMATCH";
    if (input.reservations.length > 10000) return "CAPACITY_RECORD_LIMIT";
    const rows = input.reservations.map((row) => {
      if (
        !row.mandateId ||
        !["POSITION", "PENDING", "MANAGEMENT"].includes(row.kind) ||
        !["RESERVED", "COMMITTED", "UNCERTAIN"].includes(row.status)
      )
        throw new Error("Invalid reservation");
      return {
        ...row,
        risk: u(TradingDecimalSchema.parse(row.risk)),
        exposure: u(TradingDecimalSchema.parse(row.exposure)),
        margin: u(TradingDecimalSchema.parse(row.margin)),
      };
    });
    const incrementalRisk = u(TradingDecimalSchema.parse(assessment.incrementalRisk));
    const exposure = u(TradingDecimalSchema.parse(assessment.notional));
    const margin = u(TradingDecimalSchema.parse(assessment.margin));
    // Validated risk reduction must remain available when existing exposure breaches a ceiling.
    if (assessment.classification === "REDUCES_RISK") return null;
    const own = rows.filter((row) => row.mandateId === input.mandateId);
    if (own.reduce((total, row) => total + row.margin, 0n) + margin > u(envelope.allocatedCapital))
      return "MISSION_ALLOCATED_CAPITAL_LIMIT";
    if (
      rows.reduce((total, row) => total + row.risk, 0n) + incrementalRisk >
      u(limits.maxReservedRisk)
    )
      return "ACCOUNT_RESERVED_RISK_LIMIT";
    if (rows.reduce((total, row) => total + row.exposure, 0n) + exposure > u(limits.maxExposure))
      return "ACCOUNT_EXPOSURE_LIMIT";
    // Confirmed pending orders reserve margin too: broker used margin may exclude them entirely.
    const reservedMargin = rows
      .filter((row) => row.status !== "COMMITTED" || row.kind === "PENDING")
      .reduce((total, row) => total + row.margin, 0n);
    const mandateMarginPercent = u(envelope.maxMarginUsagePercent);
    const accountMarginPercent = u(limits.maxMarginUsagePercent ?? envelope.maxMarginUsagePercent);
    const percent =
      mandateMarginPercent < accountMarginPercent ? mandateMarginPercent : accountMarginPercent;
    if (
      percent > 100n * FINANCIAL_SCALE ||
      (u(facts.margin) + reservedMargin + margin) * 100n * FINANCIAL_SCALE >
        u(facts.equity) * percent ||
      reservedMargin + margin > u(facts.freeMargin)
    )
      return "ACCOUNT_RESERVED_MARGIN_LIMIT";
    const pending = rows
      .filter((row) => row.kind === "PENDING")
      .reduce((total, row) => total + row.exposure, 0n);
    const pendingIncrement =
      action.operation === "MODIFY_ORDER" ||
      (action.operation === "OPEN" && action.orderType !== "MARKET")
        ? exposure
        : 0n;
    if (pending + pendingIncrement > u(limits.maxPendingExposure))
      return "ACCOUNT_PENDING_EXPOSURE_LIMIT";
    return null;
  } catch {
    return "INVALID_CAPACITY_INPUT";
  }
}
