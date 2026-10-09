import { createHash, timingSafeEqual } from "node:crypto";
import type { FinancialAction } from "@rakazo/contracts";
import {
  FinancialActionSchema,
  TradingAuthorityEnvelopeSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Invalid canonical value");
  return result;
}

export function canonicalFinancialAction(input: unknown): FinancialAction {
  const action = FinancialActionSchema.parse(input);
  if ("expiresAt" in action && action.expiresAt !== null) {
    return { ...action, expiresAt: new Date(action.expiresAt).toISOString() };
  }
  return action;
}

export function financialActionFingerprint(input: unknown): string {
  const action = canonicalFinancialAction(input);
  return createHash("sha256")
    .update(`financial-action:v1\n${canonicalJson(action)}`)
    .digest("hex");
}

export function tradingAuthorityFingerprint(input: unknown): string {
  const envelope = TradingAuthorityEnvelopeSchema.parse(input);
  const normalized = {
    ...envelope,
    allowedInstruments: [...new Set(envelope.allowedInstruments)].sort(),
    allowedOperations: [...new Set(envelope.allowedOperations)].sort(),
    expiresAt: new Date(envelope.expiresAt).toISOString(),
  };
  return createHash("sha256")
    .update(`trading-authority:v1\n${canonicalJson(normalized)}`)
    .digest("hex");
}

/** The bootstrap proof is stored as a digest; this helper never logs or returns it. */
export function ownerBootstrapProofDigest(proof: string): string {
  if (proof.length < 32 || proof.length > 256) throw new Error("Invalid bootstrap proof length");
  return createHash("sha256").update(`owner-bootstrap:v1\n${proof}`).digest("hex");
}

export function verifyOwnerBootstrapProof(expectedDigest: string | null, proof: string): boolean {
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)) return false;
  if (proof.length < 32 || proof.length > 256) return false;
  return timingSafeEqual(
    Buffer.from(expectedDigest, "hex"),
    Buffer.from(ownerBootstrapProofDigest(proof), "hex"),
  );
}

/** Full mandate hash includes every hard bound/permission, not just the legacy envelope subset. */
export function tradingMandateFingerprint(input: unknown): string {
  const envelope = TradingMandateEnvelopeSchema.parse(input);
  const normalized = {
    ...envelope,
    allowedInstruments: [...new Set(envelope.allowedInstruments)].sort(),
    allowedOperations: [...new Set(envelope.allowedOperations)].sort(),
    allowedOrderTypes: [...new Set(envelope.allowedOrderTypes)].sort(),
    riskIncreasePermissions: [...new Set(envelope.riskIncreasePermissions)].sort(),
    supervisedOrderIds: [...new Set(envelope.supervisedOrderIds)].sort(),
    expiresAt: new Date(envelope.expiresAt).toISOString(),
  };
  return createHash("sha256")
    .update(`trading-mandate:v1\n${canonicalJson(normalized)}`)
    .digest("hex");
}
