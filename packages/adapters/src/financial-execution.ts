import type { AdapterContext, AutoReviewProvider } from "@rakazo/adapter-kit";
import type {
  FinancialAction,
  FinancialEffectOutcome,
  FinancialRiskFacts,
} from "@rakazo/contracts";
import {
  FinancialEffectOutcomeSchema,
  TradeExecuteCommandSchema,
  TradeReconcileCommandSchema,
} from "@rakazo/contracts";
import { canonicalFinancialAction } from "@rakazo/core/node/financial-action";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { buildFinancialApprovalAskBlock } from "./approval-ask.js";
import type { ChartActor } from "./cloud-charts.js";
import { FinancialEffects } from "./financial-effects.js";
import { financialPreflight } from "./financial-preflight.js";
import { SimulationBroker } from "./simulation-broker.js";

type Effect = Prisma.ExternalEffectGetPayload<Record<never, never>>;
type Preflight = (
  actor: ChartActor,
  action: FinancialAction,
  signal?: AbortSignal,
) => Promise<FinancialRiskFacts>;
function view(effect: Effect) {
  const result = FinancialEffectOutcomeSchema.safeParse(effect.result);
  return {
    effectId: effect.id,
    status:
      effect.status === "completed"
        ? ("SUCCEEDED" as const)
        : effect.status === "failed"
          ? ("FAILED" as const)
          : effect.status === "denied"
            ? ("DENIED" as const)
            : ("UNCERTAIN" as const),
    mode: "SIMULATION" as const,
    providerReference: effect.financialProviderReference,
    ...(result.success ? { result: result.data } : {}),
  };
}

/** Domain-owned handler in the existing tool executor; no scheduler or broker session of its own. */
export class FinancialExecution {
  private readonly preflight: Preflight;
  private readonly effects: FinancialEffects;
  private readonly simulator: SimulationBroker;
  constructor(
    private readonly prisma: PrismaClient,
    now: () => Date = () => new Date(),
    preflight?: Preflight,
  ) {
    this.preflight =
      preflight ?? ((actor, action, signal) => financialPreflight(prisma, actor, action, signal));
    this.effects = new FinancialEffects(prisma, now);
    this.simulator = new SimulationBroker(prisma, now);
  }
  async execute(
    actor: ChartActor,
    raw: unknown,
    reviewer: AutoReviewProvider | undefined,
    context: AdapterContext,
    knownSecrets: string[] = [],
  ) {
    context.signal.throwIfAborted();
    const command = TradeExecuteCommandSchema.parse(raw);
    let effect = await this.effects.prepare(actor, command.proposalId, command.previewId);
    const action = canonicalFinancialAction(effect.request);
    if (["completed", "failed", "denied"].includes(effect.status)) return view(effect);
    if (
      effect.financialStartedAt ||
      ["executing", "uncertain", "reconciling"].includes(effect.status)
    ) {
      await this.effects.recoverInterrupted();
      return view(await this.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }));
    }
    if (effect.status === "intended" && effect.reviewDecision === null)
      effect = await this.effects.review(actor, effect.id, reviewer, context, knownSecrets);
    if (effect.status === "denied") return view(effect);
    if (effect.status === "intended")
      return {
        effectId: effect.id,
        status: "APPROVAL_REQUIRED" as const,
        mode: "SIMULATION" as const,
        ask: buildFinancialApprovalAskBlock(
          effect.id,
          action,
          knownSecrets,
          effect.reviewReason ?? undefined,
        ),
      };
    context.signal.throwIfAborted();
    const facts = await this.preflight(actor, action, context.signal);
    context.signal.throwIfAborted();
    effect = await this.effects.begin(actor, effect.id, facts);
    let outcome: FinancialEffectOutcome;
    try {
      context.signal.throwIfAborted();
      outcome = await this.simulator.execute(actor, effect.id, facts);
    } catch {
      // A timeout/transport failure after STARTED is not evidence of nonacceptance.
      outcome = FinancialEffectOutcomeSchema.parse({
        version: 1,
        status: "UNCERTAIN",
        providerReference: null,
        code: "SIMULATION_PROVIDER_ERROR",
      });
    }
    return view(await this.effects.settle(actor, effect.id, outcome));
  }
  async reconcile(actor: ChartActor, raw: unknown) {
    const command = TradeReconcileCommandSchema.parse(raw);
    await this.effects.recoverInterrupted();
    return view(await this.effects.reconcileSimulation(actor, command.effectId));
  }
}
