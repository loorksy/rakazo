import { financialUnits as u } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { simulationMissionState } from "./simulation-mission-state.js";

const input: Parameters<typeof simulationMissionState>[0] = {
  status: "ACTIVE",
  expiresAt: new Date("2026-10-10T12:00:00Z"),
  now: new Date("2026-10-10T10:00:00Z"),
  accountFrozen: false,
  hasPositions: true,
  valuationFresh: true,
  final: false,
  pnl: u("0"),
  daily: u("0"),
  openRisk: u("40"),
  largestRisk: u("20"),
  targetProfit: "300",
  limits: {
    maxMissionLoss: "100",
    maxDailyLoss: null,
    maxOpenRisk: "40",
    maxRiskPerTrade: "20",
  },
};

describe("sequential simulation mission transitions", () => {
  it("retains a transient target after the price retreats", () => {
    const reached = simulationMissionState({ ...input, pnl: u("300") });
    expect(reached).toBe("TARGET_REACHED");
    expect(simulationMissionState({ ...input, status: reached, final: true })).toBe(reached);
  });
  it("retains an aggregate loss-budget breach after the price recovers", () => {
    const stopped = simulationMissionState({ ...input, pnl: u("-61") });
    expect(stopped).toBe("RISK_STOPPED");
    expect(simulationMissionState({ ...input, status: stopped, final: true })).toBe(stopped);
  });
  it("retains a transient daily loss-budget breach", () => {
    const stopped = simulationMissionState({
      ...input,
      daily: u("-11"),
      limits: { ...input.limits, maxDailyLoss: "50" },
    });
    expect(stopped).toBe("RISK_STOPPED");
    expect(simulationMissionState({ ...input, status: stopped })).toBe(stopped);
  });
  it.each(["PAUSED", "NEEDS_RECONCILIATION", "CANCELLED", "NEEDS_ATTENTION"])(
    "does not reactivate %s based on market telemetry",
    (status) => expect(simulationMissionState({ ...input, status, pnl: u("500") })).toBe(status),
  );
  it("waits for the rest of a partial quote batch before declaring missing valuation", () => {
    expect(simulationMissionState({ ...input, valuationFresh: false })).toBe("ACTIVE");
    expect(simulationMissionState({ ...input, valuationFresh: false, final: true })).toBe(
      "NEEDS_ATTENTION",
    );
  });
  it("does not certify a target or loss from stale or incomplete valuation", () => {
    expect(simulationMissionState({ ...input, valuationFresh: false, pnl: u("500") })).toBe(
      "ACTIVE",
    );
    expect(simulationMissionState({ ...input, valuationFresh: false, pnl: u("-500") })).toBe(
      "ACTIVE",
    );
  });
  it("keeps expiry and the account freeze stronger than target attainment", () => {
    expect(simulationMissionState({ ...input, accountFrozen: true, pnl: u("500") })).toBe("PAUSED");
    expect(
      simulationMissionState({
        ...input,
        expiresAt: input.now,
        accountFrozen: true,
        pnl: u("500"),
      }),
    ).toBe("EXPIRED");
  });
  it.each([
    { pnl: u("-100") },
    { daily: u("-50"), limits: { ...input.limits, maxDailyLoss: "50" } },
    { openRisk: u("40.000000000001") },
    { largestRisk: u("20.000000000001") },
  ])("enforces exact hard limits without floating-point comparisons", (change) => {
    expect(simulationMissionState({ ...input, ...change })).toBe("RISK_STOPPED");
  });
});
