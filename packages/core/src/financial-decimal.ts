import { SignedTradingDecimalSchema } from "@rakazo/contracts";
export const FINANCIAL_SCALE = 1_000_000_000_000n;
export function financialUnits(raw: string): bigint {
  const value = SignedTradingDecimalSchema.parse(raw);
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole) * FINANCIAL_SCALE + BigInt(fraction.padEnd(12, "0"));
  return negative ? -result : result;
}
export function financialDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % FINANCIAL_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / FINANCIAL_SCALE}${fraction ? `.${fraction}` : ""}`;
}
/** Positive division rounds toward the safety boundary, never down. */
export function financialCeil(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("Invalid positive financial division");
  return (numerator + denominator - 1n) / denominator;
}
