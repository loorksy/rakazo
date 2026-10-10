import type { FinancialAction, TradingMandateEnvelope } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { mandateActionAuthority } from "./mandate-action-authority.js";

const action = {
  operation: "CANCEL_ORDER",
  accountId: "account",
  mode: "SIMULATION",
  instrumentId: "gold",
} as FinancialAction;
const envelope = {
  accountId: "account",
  mode: "SIMULATION",
  allowedOperations: ["CANCEL_ORDER", "CLOSE_POSITION", "OPEN", "MODIFY_PROTECTION"],
  allowedInstruments: ["gold"],
  expiresAt: "2026-10-10T12:00:00Z",
  expiryBehavior: "CANCEL_PENDING",
  breachBehavior: "CLOSE_ATTRIBUTED_EXPOSURE",
  targetBehavior: "CLOSE_ATTRIBUTED_EXPOSURE",
} as TradingMandateEnvelope;
const base = {
  status: "EXPIRED",
  envelope,
  action,
  startsAt: "2026-10-10T09:00:00Z",
  endsAt: envelope.expiresAt,
  now: new Date("2026-10-10T12:01:00Z"),
};
describe("unchanged owner mandate finishing authority", () => {
  it("allows only the selected terminal reduction", () => {
    expect(mandateActionAuthority(base)).toBe("FINISHING");
    expect(
      mandateActionAuthority({
        ...base,
        status: "TARGET_REACHED",
        action: { ...action, operation: "CLOSE_POSITION", volume: null } as FinancialAction,
      }),
    ).toBe("FINISHING");
    expect(
      mandateActionAuthority({
        ...base,
        action: { ...action, operation: "CLOSE_POSITION", volume: null } as FinancialAction,
      }),
    ).toBeNull();
  });
  it.each(["PAUSED", "CANCELLED", "NEEDS_ATTENTION", "NEEDS_RECONCILIATION", "COMPLETED"])(
    "does not reinterpret %s as permission",
    (status) => {
      expect(mandateActionAuthority({ ...base, status })).toBeNull();
    },
  );
  it.each(["OPEN", "MODIFY_PROTECTION", "MODIFY_ORDER"])(
    "never authorizes %s from a terminal mandate",
    (operation) => {
      expect(
        mandateActionAuthority({
          ...base,
          status: "TARGET_REACHED",
          action: { ...action, operation } as FinancialAction,
        }),
      ).toBeNull();
    },
  );
  it("denies partial close, FREEZE, foreign identity and operations omitted by the owner", () => {
    expect(
      mandateActionAuthority({
        ...base,
        status: "RISK_STOPPED",
        action: { ...action, operation: "CLOSE_POSITION", volume: "0.1" } as FinancialAction,
      }),
    ).toBeNull();
    expect(
      mandateActionAuthority({ ...base, envelope: { ...envelope, expiryBehavior: "FREEZE" } }),
    ).toBeNull();
    expect(
      mandateActionAuthority({ ...base, action: { ...action, accountId: "foreign" } }),
    ).toBeNull();
    expect(
      mandateActionAuthority({ ...base, envelope: { ...envelope, allowedOperations: ["OPEN"] } }),
    ).toBeNull();
  });
  it("uses expiry behavior even before a delayed expiry wake and never reactivates new risk", () => {
    expect(mandateActionAuthority({ ...base, status: "ACTIVE" })).toBe("FINISHING");
    expect(
      mandateActionAuthority({ ...base, status: "ACTIVE", now: new Date("2026-10-10T10:00:00Z") }),
    ).toBe("ACTIVE");
  });
});
