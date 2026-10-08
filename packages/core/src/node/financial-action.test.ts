import { describe, expect, it } from "vitest";
import {
  canonicalFinancialAction,
  financialActionFingerprint,
  ownerBootstrapProofDigest,
  tradingAuthorityFingerprint,
  verifyOwnerBootstrapProof,
} from "./financial-action.js";

const action = {
  version: 1,
  mode: "SIMULATION",
  provider: "fixture",
  accountId: "account-a",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  operation: "OPEN",
  side: "BUY",
  orderType: "LIMIT",
  volume: "0.10",
  price: "2700.00",
  stopLimitPrice: null,
  stopLoss: "2690.00",
  takeProfit: "2720.00",
  fillingMode: null,
  expiresAt: "2026-10-09T00:00:00Z",
};
const authority = {
  version: 1,
  ownerId: "owner",
  botId: "main",
  accountId: "account-a",
  mode: "SIMULATION",
  expiresAt: "2026-10-09T00:00:00Z",
  allowedInstruments: ["gold", "eurusd"],
  allowedOperations: ["OPEN", "CLOSE_POSITION"],
  maxMissionLoss: "100",
  maxOpenRisk: "50",
  maxRiskPerTrade: "20",
  maxConcurrentPositions: 2,
  maxPendingOrders: 1,
  breachBehavior: "FREEZE",
  expiryBehavior: "CANCEL_PENDING",
};

describe("canonical financial authority", () => {
  it("normalizes decimal text without losing precision or broker symbol suffixes", () => {
    expect(canonicalFinancialAction({ ...action, price: "9007199254740993.1200" })).toMatchObject({
      price: "9007199254740993.12",
      volume: "0.1",
      brokerSymbol: "GOLD.a",
    });
  });
  it("binds meaning rather than object insertion order or decimal formatting", () => {
    const reordered = Object.fromEntries(Object.entries(action).reverse());
    expect(financialActionFingerprint(reordered)).toBe(financialActionFingerprint(action));
    expect(financialActionFingerprint({ ...action, volume: "0.1", price: "2700" })).toBe(
      financialActionFingerprint(action),
    );
  });
  it("normalizes equivalent expiration times", () => {
    expect(financialActionFingerprint({ ...action, expiresAt: "2026-10-09T01:00:00+01:00" })).toBe(
      financialActionFingerprint(action),
    );
  });
  it.each([
    ["mode", "LIVE"],
    ["provider", "other"],
    ["accountId", "account-b"],
    ["instrumentId", "silver"],
    ["brokerSymbol", "XAUUSD"],
    ["side", "SELL"],
    ["orderType", "STOP"],
    ["volume", "0.11"],
    ["price", "2701"],
    ["stopLoss", "2689"],
    ["takeProfit", "2721"],
    ["fillingMode", "FOK"],
    ["expiresAt", "2026-10-10T00:00:00Z"],
  ])("invalidates authorization when material field %s changes", (field, value) => {
    expect(financialActionFingerprint({ ...action, [field]: value })).not.toBe(
      financialActionFingerprint(action),
    );
  });
  it.each([0.1, "NaN", "Infinity", "1e3", "-1", "0", "0.1234567890123"])(
    "rejects unsafe or unbounded volume %s",
    (volume) => {
      expect(() => canonicalFinancialAction({ ...action, volume })).toThrow();
    },
  );
  it("rejects hidden material fields and model-supplied approval", () => {
    expect(() => canonicalFinancialAction({ ...action, approved: true })).toThrow();
    expect(() => canonicalFinancialAction({ ...action, arbitraryHttp: "/trade" })).toThrow();
  });
  it("validates requested price and stop-limit semantics", () => {
    expect(() => canonicalFinancialAction({ ...action, orderType: "MARKET" })).toThrow();
    expect(() => canonicalFinancialAction({ ...action, orderType: "STOP_LIMIT" })).toThrow();
    expect(() =>
      canonicalFinancialAction({ ...action, orderType: "STOP_LIMIT", stopLimitPrice: "2702" }),
    ).not.toThrow();
  });
  it("binds full versus partial close and the exact provider position", () => {
    const close = {
      version: 1,
      mode: "SIMULATION",
      provider: "fixture",
      accountId: "account-a",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
      operation: "CLOSE_POSITION",
      positionId: "ticket-1",
      volume: null,
    };
    expect(financialActionFingerprint(close)).not.toBe(
      financialActionFingerprint({ ...close, volume: "0.1" }),
    );
    expect(financialActionFingerprint(close)).not.toBe(
      financialActionFingerprint({ ...close, positionId: "ticket-2" }),
    );
  });
  it("normalizes sets in authority without ignoring limits or Bot identity", () => {
    expect(
      tradingAuthorityFingerprint({ ...authority, allowedInstruments: ["eurusd", "gold", "gold"] }),
    ).toBe(tradingAuthorityFingerprint(authority));
    for (const change of [
      { botId: "peer" },
      { mode: "LIVE" },
      { maxMissionLoss: "101" },
      { breachBehavior: "CLOSE_ATTRIBUTED_EXPOSURE" },
    ]) {
      expect(tradingAuthorityFingerprint({ ...authority, ...change })).not.toBe(
        tradingAuthorityFingerprint(authority),
      );
    }
    expect(() => tradingAuthorityFingerprint({ ...authority, approvedByBot: true })).toThrow();
  });
  it("checks bootstrap proofs against a versioned digest, including malformed inputs", () => {
    const sentinel = "test-only-bootstrap-proof-not-a-credential";
    const digest = ownerBootstrapProofDigest(sentinel);
    expect(verifyOwnerBootstrapProof(digest, sentinel)).toBe(true);
    expect(verifyOwnerBootstrapProof(digest, `${sentinel}x`)).toBe(false);
    expect(verifyOwnerBootstrapProof(digest, "short")).toBe(false);
    expect(verifyOwnerBootstrapProof(null, sentinel)).toBe(false);
    expect(verifyOwnerBootstrapProof("bad-digest", sentinel)).toBe(false);
    expect(() => ownerBootstrapProofDigest("short")).toThrow();
    expect(digest).not.toContain(sentinel);
  });
});
