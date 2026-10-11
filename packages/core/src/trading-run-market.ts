import { FINANCIAL_SCALE, financialDecimal, financialUnits } from "./financial-decimal.js";

export interface PinnedMarket {
  accountId: string;
  instrumentId: string;
  brokerSymbol: string;
  provider: string;
}

export type MarketPinDecision =
  | { action: "pin" }
  | { action: "allow"; supplementary: boolean }
  | { action: "deny"; message: string };

/** The first exact instrument stays the recommendation. A comparison does not replace it. */
export function marketPinDecision(
  existing: PinnedMarket | null,
  requested: { accountId: string; instrumentId: string; brokerSymbol: string },
  supplementary: boolean,
): MarketPinDecision {
  if (!existing) {
    if (supplementary)
      return {
        action: "deny",
        message: "Pin the primary broker instrument before comparing another one.",
      };
    return { action: "pin" };
  }
  if (existing.accountId !== requested.accountId)
    return {
      action: "deny",
      message: `This run is pinned to ${existing.brokerSymbol}. Do not switch broker account.`,
    };
  if (existing.instrumentId === requested.instrumentId) return { action: "allow", supplementary };
  if (supplementary) return { action: "allow", supplementary: true };
  return {
    action: "deny",
    message: `This run is pinned to ${existing.brokerSymbol}. Do not read ${requested.brokerSymbol} unless the read is supplementary cross-market evidence.`,
  };
}

export interface ProtectionPreviewInput {
  side: "BUY" | "SELL";
  entry: string;
  stop: string | null;
  target: string | null;
  volume: string;
  contractSize: string | null;
}

function move(
  side: "BUY" | "SELL",
  entry: string,
  price: string,
  favorable: boolean,
): bigint | null {
  try {
    const from = financialUnits(entry);
    const to = financialUnits(price);
    const span = side === "BUY" ? to - from : from - to;
    const directed = favorable ? span : -span;
    return directed > 0n ? directed : null;
  } catch {
    return null;
  }
}

/** Deterministic money from broker specification. Null means the preview is unavailable. */
export function previewProtection(input: ProtectionPreviewInput): {
  loss: string | null;
  profit: string | null;
} {
  if (!input.contractSize) return { loss: null, profit: null };
  try {
    const size = financialUnits(input.contractSize);
    const volume = financialUnits(input.volume);
    const money = (span: bigint | null) =>
      span === null
        ? null
        : financialDecimal((span * size * volume) / (FINANCIAL_SCALE * FINANCIAL_SCALE));
    return {
      loss: input.stop ? money(move(input.side, input.entry, input.stop, false)) : null,
      profit: input.target ? money(move(input.side, input.entry, input.target, true)) : null,
    };
  } catch {
    return { loss: null, profit: null };
  }
}

/** Stable identity of a preview. A lot edit produces a different value. */
export function executionFingerprint(parts: readonly string[]): string {
  let hash = 5381;
  const text = parts.join("\u001f");
  for (let index = 0; index < text.length; index++) hash = (hash * 33) ^ text.charCodeAt(index);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const ASSUMED_BALANCE = /(?:\$|USD\s*)?(?:10[, ]?000|100[, ]?000)\b/i;

export function assumesAccountBalance(text: string): boolean {
  return ASSUMED_BALANCE.test(text);
}
