import type { AdapterContext, AutoReviewProvider } from "@rakazo/adapter-kit";
import { redactToolArgsForReview } from "./auto-review.js";

/** Mandatory support-tool check. Neither an allow rule nor a generic approval is financial authority. */
export async function reviewTradingSupport(input: {
  toolName: string;
  args: Record<string, unknown>;
  userTask: string;
  provider?: AutoReviewProvider;
  context: AdapterContext;
  knownSecrets: string[];
}): Promise<boolean> {
  input.context.signal.throwIfAborted();
  if (!input.provider) return false;
  const signal = AbortSignal.any([input.context.signal, AbortSignal.timeout(1500)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      input.provider.review(
        {
          toolName: input.toolName,
          connectorKind: "trading_support",
          args: redactToolArgsForReview(input.args, input.knownSecrets),
          userTask: input.userTask,
          botDescription:
            "Professional trading Agent. This support tool has no broker mutation authority. Only credential-free research and ordinary nonfinancial Computer work may pass.",
          matchingRules: [],
        },
        { ...input.context, signal },
      ),
      new Promise<{ decision: "deny" }>((resolve) => {
        timer = setTimeout(() => resolve({ decision: "deny" }), 1500);
      }),
    ]);
    input.context.signal.throwIfAborted();
    return result.decision === "pass";
  } catch {
    input.context.signal.throwIfAborted();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
