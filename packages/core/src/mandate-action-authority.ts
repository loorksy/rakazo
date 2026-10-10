import type { FinancialAction, TradingMandateEnvelope } from "@rakazo/contracts";

/** Backend state plus the unchanged owner envelope; never a tool-supplied finishing flag. */
export function mandateActionAuthority(input: {
  status: string;
  envelope: TradingMandateEnvelope;
  action: FinancialAction;
  startsAt: string;
  endsAt: string;
  now: Date;
}): "ACTIVE" | "FINISHING" | null {
  const { envelope, action, status } = input;
  const now = input.now.getTime();
  const start = Date.parse(input.startsAt);
  const end = Math.min(Date.parse(input.endsAt), Date.parse(envelope.expiresAt));
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    now < start ||
    action.accountId !== envelope.accountId ||
    action.mode !== envelope.mode ||
    !envelope.allowedOperations.includes(action.operation) ||
    !envelope.allowedInstruments.includes(action.instrumentId)
  )
    return null;
  if (status === "ACTIVE" && now < end) return "ACTIVE";
  if (status === "EXPIRED" && now < end) return null;
  let behavior: TradingMandateEnvelope["expiryBehavior"];
  if (status === "EXPIRED" || (status === "ACTIVE" && now >= end))
    behavior = envelope.expiryBehavior;
  else if (status === "RISK_STOPPED") behavior = envelope.breachBehavior;
  else if (status === "TARGET_REACHED") behavior = envelope.targetBehavior;
  else if (status === "EMERGENCY_STOPPED" && now < end)
    behavior = envelope.emergencyBehavior ?? "FREEZE";
  else return null;
  if (behavior === "FREEZE") return null;
  if (action.operation === "CANCEL_ORDER") return "FINISHING";
  if (
    behavior === "CLOSE_ATTRIBUTED_EXPOSURE" &&
    action.operation === "CLOSE_POSITION" &&
    action.volume === null
  )
    return "FINISHING";
  return null;
}
