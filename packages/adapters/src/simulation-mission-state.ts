import type { TradingMandateEnvelope } from "@rakazo/contracts";
import { financialUnits as u } from "@rakazo/core";

/** Pure mission transition; terminal outcomes remain sticky throughout a quote batch. */
export function simulationMissionState(input: {
  status: string;
  expiresAt: Date;
  now: Date;
  accountFrozen: boolean;
  hasPositions: boolean;
  valuationFresh: boolean;
  final: boolean;
  pnl: bigint;
  daily: bigint;
  openRisk: bigint;
  largestRisk: bigint;
  targetProfit: string | null;
  limits: Pick<
    TradingMandateEnvelope,
    "maxMissionLoss" | "maxDailyLoss" | "maxOpenRisk" | "maxRiskPerTrade"
  >;
}): string {
  if (input.status !== "ACTIVE") return input.status;
  if (input.expiresAt <= input.now) return "EXPIRED";
  if (input.accountFrozen) return "PAUSED";
  if (!input.valuationFresh)
    return input.final && input.hasPositions ? "NEEDS_ATTENTION" : input.status;
  const { limits, pnl, daily, openRisk } = input;
  if (
    pnl <= -u(limits.maxMissionLoss) ||
    (pnl < 0n ? -pnl : 0n) + openRisk > u(limits.maxMissionLoss) ||
    (limits.maxDailyLoss !== null &&
      (daily <= -u(limits.maxDailyLoss) ||
        (daily < 0n ? -daily : 0n) + openRisk > u(limits.maxDailyLoss))) ||
    openRisk > u(limits.maxOpenRisk) ||
    input.largestRisk > u(limits.maxRiskPerTrade)
  )
    return "RISK_STOPPED";
  if (input.targetProfit !== null && pnl >= u(input.targetProfit)) return "TARGET_REACHED";
  return input.status;
}
