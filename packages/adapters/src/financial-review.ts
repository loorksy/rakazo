import type { AdapterContext, AutoReviewProvider, AutoReviewResult } from "@rakazo/adapter-kit";
import type { FinancialReviewContext } from "@rakazo/contracts";
import { FinancialReviewContextSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import {
  financialActionFingerprint,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import { redactToolArgsForReview, sanitizeAutoReviewReason } from "./auto-review.js";

/** Reuses Auto Review; this function owns no execution, approval, or broker capability. */
export async function reviewFinancialAction(input: {
  financial: FinancialReviewContext;
  provider?: AutoReviewProvider;
  context: AdapterContext;
  knownSecrets?: string[];
  timeoutMs?: number;
  now?: Date;
}): Promise<AutoReviewResult> {
  input.context.signal.throwIfAborted();
  const financial = FinancialReviewContextSchema.parse(input.financial);
  const now = input.now ?? new Date();
  const age = now.getTime() - Date.parse(financial.observedAt);
  const deny = {
    decision: "deny" as const,
    model: "deterministic",
    reason: "Financial policy or risk denied this action.",
  };
  if (
    financial.risk.decision === "DENY" ||
    financial.actionFingerprint !== financialActionFingerprint(financial.action) ||
    financial.mandateFingerprint !== tradingMandateFingerprint(financial.envelope) ||
    financial.action.accountId !== financial.envelope.accountId ||
    financial.action.mode !== financial.envelope.mode ||
    input.context.userId !== financial.envelope.ownerId ||
    input.context.botId !== financial.envelope.botId ||
    Date.parse(financial.envelope.expiresAt) <= now.getTime() ||
    age < -2000 ||
    age > 15000
  )
    return deny;
  const fallback = {
    decision: "ask" as const,
    model: "unavailable",
    reason: "Independent review unavailable; owner review required.",
  };
  if (!input.provider) return fallback;
  const timeout = Math.min(30000, Math.max(200, input.timeoutMs ?? 1500));
  const secrets = input.knownSecrets ?? [];
  const redacted = FinancialReviewContextSchema.parse(
    redactToolArgsForReview({ financial }, secrets).financial,
  );
  const controller = new AbortController();
  const signal = AbortSignal.any([input.context.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const unavailable = new Promise<AutoReviewResult>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(fallback);
      }, timeout);
      onAbort = () => reject(new Error("Financial review cancelled"));
      input.context.signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([
      unavailable,
      input.provider.review(
        {
          toolName: "trade_execute",
          connectorKind: "financial",
          args: { action: redacted.action },
          userTask:
            "Evaluate only this exact action within approved hard authority. Profit targets cannot enlarge risk.",
          botDescription: "Main Trading Agent under owner-approved bounded mandate.",
          matchingRules: [],
          financial: redacted,
        },
        { ...input.context, operationId: `financial-review:${input.context.operationId}`, signal },
      ),
    ]);
    input.context.signal.throwIfAborted();
    if (!["pass", "ask", "deny"].includes(result.decision)) return fallback;
    return {
      decision: result.decision,
      model: redactSecrets(String(result.model).slice(0, 200), secrets),
      reason: sanitizeAutoReviewReason(redactSecrets(result.reason ?? "", secrets)),
    };
  } catch {
    input.context.signal.throwIfAborted();
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.context.signal.removeEventListener("abort", onAbort);
  }
}
