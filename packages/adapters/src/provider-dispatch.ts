import type { BrokerReadSession, ExecutionRequest, ExecutionResult } from "@rakazo/adapter-kit";
import type { FinancialRiskFacts } from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  FinancialEffectContextSchema,
  FinancialEffectOutcomeSchema,
  FinancialRiskFactsSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { accountRiskCapacity, financialDecimal, financialUnits } from "@rakazo/core";
import {
  canonicalFinancialAction,
  financialActionFingerprint,
} from "@rakazo/core/node/financial-action";
import type { BrokerLeaseToken, PrismaClient } from "@rakazo/db";
import { Prisma, withBrokerSessionFence } from "@rakazo/db";
import type { BrokerState } from "./broker-state.js";
import {
  BrokerOrderStateSchema,
  BrokerPositionStateSchema,
  readBrokerState,
} from "./broker-state.js";
import { FinancialEffects } from "./financial-effects.js";
import { attributedFinancialAssessment, financialTarget } from "./financial-target.js";
import { requireLiveReadiness } from "./live-readiness.js";
import { confirmProviderMutation, ProviderAdmissionSchema } from "./provider-confirmation.js";

/** Only the trusted broker-session Worker constructs this dispatcher. */
export class ProviderDispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async identity(tx: Prisma.TransactionClient, id: string, accountId: string) {
    const dispatch = await tx.tradingProviderExecution.findUniqueOrThrow({
      where: { effectId: id },
    });
    const effect = await tx.externalEffect.findUniqueOrThrow({ where: { id } });
    const context = FinancialEffectContextSchema.parse(effect.financialContext);
    const action = canonicalFinancialAction(effect.request);
    if (
      context.version !== 2 ||
      context.mode !== "LIVE" ||
      action.mode !== "LIVE" ||
      context.accountId !== accountId ||
      action.accountId !== accountId ||
      dispatch.accountId !== accountId ||
      dispatch.ownerUserId !== context.ownerUserId ||
      dispatch.clientId !== context.clientId ||
      dispatch.actionFingerprint !== context.actionFingerprint ||
      financialActionFingerprint(action) !== context.actionFingerprint ||
      !effect.financialStartedAt
    )
      throw new Error("Durable provider execution identity mismatch");
    const request: ExecutionRequest = {
      effectId: id,
      clientId: context.clientId,
      action,
      startedAt: effect.financialStartedAt.toISOString(),
    };
    return { dispatch, effect, context, request };
  }

  async tick(token: BrokerLeaseToken, session: BrokerReadSession) {
    if (session.accountId !== token.accountId) throw new Error("Provider session account mismatch");
    const pending = await this.prisma.tradingProviderExecution.findFirst({
      where: { accountId: token.accountId, status: { in: ["PENDING", "SENT", "UNCERTAIN"] } },
      orderBy: { createdAt: "asc" },
    });
    if (!pending) return;
    if (pending.status !== "PENDING") {
      const request = await withBrokerSessionFence(
        this.prisma,
        token,
        async (tx) => {
          const identity = await this.identity(tx, pending.effectId, token.accountId);
          return identity.dispatch.status === "RESOLVED" ? null : identity.request;
        },
        this.now(),
      );
      if (!request) return;
      let result: ExecutionResult;
      try {
        result = session.execution
          ? await session.execution.reconcile(request)
          : { status: "UNCERTAIN", providerReference: null, code: "CAPABILITY_UNAVAILABLE" };
      } catch {
        result = { status: "UNCERTAIN", providerReference: null, code: "PROVIDER_OUTCOME_UNKNOWN" };
      }
      await this.record(token, pending.effectId, result, true, session);
      return;
    }
    const initial = await this.prisma.externalEffect.findUniqueOrThrow({
      where: { id: pending.effectId },
    });
    const action = canonicalFinancialAction(initial.request);
    // Preflight is read-only and occurs before the durable send claim.
    let facts: FinancialRiskFacts;
    try {
      if (!session.preflight || !session.execution) throw new Error("Execution unavailable");
      facts = FinancialRiskFactsSchema.parse(await session.preflight(action));
    } catch {
      await this.record(
        token,
        pending.effectId,
        { status: "FAILED", providerReference: null, code: "PREFLIGHT_UNAVAILABLE" },
        false,
      );
      return;
    }
    let request: ExecutionRequest | null;
    try {
      request = await withBrokerSessionFence(
        this.prisma,
        token,
        async (tx) => {
          const { dispatch, effect, context, request } = await this.identity(
            tx,
            pending.effectId,
            token.accountId,
          );
          if (dispatch.status !== "PENDING") return null;
          if (
            effect.status !== "executing" ||
            !effect.financialExpiresAt ||
            effect.financialExpiresAt <= this.now() ||
            this.now().getTime() - effect.financialStartedAt!.getTime() > 15000
          )
            throw new Error("Provider admission expired");
          const { mandate, authority } = await new FinancialEffects(
            this.prisma,
            this.now,
          ).authority(tx, context, action);
          await requireLiveReadiness(tx, {
            ownerUserId: context.ownerUserId,
            botId: context.botId,
            mandateId: context.authorizationId,
            action,
            facts,
            effectId: effect.id,
            now: this.now(),
          });
          const reservation = await tx.tradingRiskReservation.findUniqueOrThrow({
            where: { effectId: effect.id },
          });
          if (
            reservation.status !== "RESERVED" ||
            reservation.actionFingerprint !== context.actionFingerprint ||
            reservation.mandateId !== mandate.id ||
            reservation.executionGeneration !== effect.financialGeneration
          )
            throw new Error("Provider reservation mismatch");
          const all = await tx.tradingRiskReservation.findMany({
            where: {
              accountId: token.accountId,
              mode: "LIVE",
              status: { in: ["RESERVED", "COMMITTED", "UNCERTAIN"] },
              effectId: { not: effect.id },
            },
            take: 10001,
          });
          if (all.length > 10000) throw new Error("Risk ledger capacity exceeded");
          const own = all.filter((row) => row.mandateId === mandate.id);
          const sum = (field: "risk" | "exposure") =>
            financialDecimal(
              own.reduce((value, row) => value + financialUnits(row[field].toFixed()), 0n),
            );
          const envelope = TradingMandateEnvelopeSchema.parse(mandate.envelope);
          const attribution = await financialTarget(
            tx,
            context.ownerUserId,
            mandate.id,
            action,
            facts,
          );
          const { assessment, settlement } = attributedFinancialAssessment({
            action,
            envelope,
            facts,
            attribution,
            now: this.now(),
            state: {
              version: 1,
              missionPnl: mandate.missionPnl.toFixed(),
              dailyPnl: mandate.dailyPnl.toFixed(),
              openRisk: sum("risk"),
              openNotional: sum("exposure"),
              positions: own.filter((row) => row.kind === "POSITION").length,
              pendingOrders: own.filter((row) => row.kind === "PENDING").length,
              unresolvedEffects: false,
              missionActive: authority === "ACTIVE",
              accountFrozen: false,
            },
          });
          if (
            assessment.decision !== "ALLOW" ||
            (authority === "FINISHING" && assessment.classification !== "REDUCES_RISK") ||
            reservation.risk.toFixed() !== assessment.incrementalRisk ||
            reservation.exposure.toFixed() !== assessment.notional ||
            reservation.margin.toFixed() !== assessment.margin
          )
            throw new Error("Provider risk admission changed");
          const guard = await tx.accountRiskGuardrail.findUniqueOrThrow({
            where: { accountId_mode: { accountId: token.accountId, mode: "LIVE" } },
          });
          const limits = AccountRiskGuardrailsSchema.parse(guard.limits);
          if (
            accountRiskCapacity({
              action,
              mandateId: mandate.id,
              envelope,
              limits,
              facts,
              assessment,
              reservations: all.map((row) => ({
                ...row,
                risk: row.risk.toFixed(),
                exposure: row.exposure.toFixed(),
                margin: row.margin.toFixed(),
              })),
            })
          )
            throw new Error("Provider account capacity changed");
          await tx.tradingProviderExecution.update({
            where: { effectId: effect.id },
            data: {
              status: "SENT",
              sentAt: this.now(),
              claimedGeneration: token.generation,
              admission: {
                targetReservationId: attribution?.reservation.id ?? null,
                target: attribution
                  ? attribution.target.kind === "POSITION"
                    ? BrokerPositionStateSchema.parse(attribution.reservation.providerState)
                    : BrokerOrderStateSchema.parse(attribution.reservation.providerState)
                  : null,
                settlement,
                expectedEntry:
                  action.operation === "OPEN"
                    ? (action.price ?? (action.side === "BUY" ? facts.quote.ask : facts.quote.bid))
                    : null,
              },
            },
          });
          await tx.financialJournal.create({
            data: {
              ownerUserId: context.ownerUserId,
              accountId: token.accountId,
              mode: "LIVE",
              effectId: effect.id,
              mandateId: mandate.id,
              goalId: context.goalId,
              event: "PROVIDER_SEND_CLAIMED",
              entry: {
                version: 1,
                actionFingerprint: context.actionFingerprint,
                clientId: context.clientId,
                facts,
                assessment,
                target: attribution?.target ?? null,
                guardrailRevision: guard.revision,
                brokerGeneration: token.generation,
              },
            },
          });
          return request;
        },
        this.now(),
      );
    } catch {
      await this.record(
        token,
        pending.effectId,
        { status: "FAILED", providerReference: null, code: "PROVIDER_ADMISSION_DENIED" },
        false,
      );
      return;
    }
    if (!request) return;
    let result: ExecutionResult;
    try {
      result = await session.execution!.execute(request);
    } catch {
      result = { status: "UNCERTAIN", providerReference: null, code: "PROVIDER_OUTCOME_UNKNOWN" };
    }
    // A process dying here leaves SENT. Another Worker only calls reconcile above.
    await this.record(token, pending.effectId, result, false, session);
  }

  private async record(
    token: BrokerLeaseToken,
    id: string,
    raw: ExecutionResult,
    reconciliation: boolean,
    session?: BrokerReadSession,
  ) {
    let observed: BrokerState | null = null;
    if (raw.status === "SUCCEEDED" && session) {
      try {
        observed = await readBrokerState(session);
      } catch {
        raw = {
          status: "UNCERTAIN",
          providerReference: raw.providerReference,
          code: "PROVIDER_STATE_UNAVAILABLE",
        };
      }
    }
    await withBrokerSessionFence(
      this.prisma,
      token,
      async (tx) => {
        const { dispatch, effect, context, request } = await this.identity(tx, id, token.accountId);
        if (dispatch.status === "RESOLVED") return;
        // A pre-send failure must never settle a concurrent sender's in-flight request.
        if (!session && !reconciliation && dispatch.status !== "PENDING") return;
        const confirmation = observed
          ? confirmProviderMutation(
              request,
              ProviderAdmissionSchema.parse(dispatch.admission),
              observed,
              raw,
            )
          : null;
        const outcome = FinancialEffectOutcomeSchema.parse({
          version: 1,
          ...(confirmation?.outcome ?? raw),
        });
        if (dispatch.status === "PENDING" && outcome.status !== "FAILED")
          throw new Error("Unsent outcome cannot be accepted");
        if (
          !reconciliation &&
          dispatch.status !== "PENDING" &&
          dispatch.claimedGeneration !== token.generation
        )
          return;
        await tx.tradingProviderExecution.update({
          where: { effectId: id },
          data: {
            status: outcome.status === "UNCERTAIN" ? "UNCERTAIN" : "RESOLVED",
            outcome,
            reconciledAt: reconciliation ? this.now() : undefined,
          },
        });
        await tx.externalEffect.update({
          where: { id },
          data: {
            status:
              outcome.status === "SUCCEEDED"
                ? "completed"
                : outcome.status === "FAILED"
                  ? "failed"
                  : "uncertain",
            result: outcome,
            financialProviderReference: outcome.providerReference,
            financialFailureCode: outcome.code,
          },
        });
        await tx.tradingRiskReservation.updateMany({
          where: { effectId: id, status: { in: ["RESERVED", "UNCERTAIN"] } },
          data: {
            status:
              outcome.status === "SUCCEEDED"
                ? "COMMITTED"
                : outcome.status === "FAILED"
                  ? "RELEASED"
                  : "UNCERTAIN",
            providerReference: outcome.providerReference,
          },
        });
        if (outcome.status === "SUCCEEDED") {
          const admission = ProviderAdmissionSchema.parse(dispatch.admission);
          if (request.action.operation === "OPEN") {
            if (!confirmation?.target) throw new Error("Confirmed provider target required");
            await tx.tradingRiskReservation.update({
              where: { effectId: id },
              data: { providerState: confirmation.target },
            });
          } else {
            if (!admission.targetReservationId || !admission.settlement)
              throw new Error("Confirmed management settlement required");
            await tx.tradingRiskReservation.update({
              where: { id: admission.targetReservationId },
              data: {
                ...admission.settlement,
                status: confirmation?.target ? "COMMITTED" : "RELEASED",
                providerState: confirmation?.target ?? Prisma.JsonNull,
              },
            });
            await tx.tradingRiskReservation.update({
              where: { effectId: id },
              data: { status: "RELEASED" },
            });
            const supervision = await tx.tradingPositionSupervision.findUnique({
              where: { mandateId: context.authorizationId },
            });
            if (supervision)
              await tx.tradingPositionSupervision.update({
                where: { id: supervision.id },
                data: {
                  expected: { position: confirmation?.target ?? null },
                  status: confirmation?.target ? supervision.status : "CLOSED",
                },
              });
          }
        }
        if (outcome.status === "UNCERTAIN")
          await tx.tradingMandate.updateMany({
            where: { id: context.authorizationId, status: { in: ["ACTIVE", "PAUSED"] } },
            data: { status: "NEEDS_RECONCILIATION", revision: { increment: 1 } },
          });
        if (reconciliation && outcome.status !== "UNCERTAIN")
          await tx.tradingMandate.updateMany({
            where: { id: context.authorizationId, status: "NEEDS_RECONCILIATION" },
            data: { status: "PAUSED", revision: { increment: 1 } },
          });
        // Repeated unresolved reads are telemetry, not duplicate financial journal evidence.
        if (dispatch.status !== "UNCERTAIN" || outcome.status !== "UNCERTAIN")
          await tx.financialJournal.create({
            data: {
              ownerUserId: context.ownerUserId,
              accountId: token.accountId,
              mode: "LIVE",
              effectId: id,
              mandateId: context.authorizationId,
              goalId: context.goalId,
              event: reconciliation ? "PROVIDER_RECONCILED" : outcome.status,
              entry: {
                version: 1,
                actionFingerprint: context.actionFingerprint,
                clientId: context.clientId,
                outcome,
              },
            },
          });
        if (effect.status === "completed" || effect.status === "failed")
          throw new Error("Provider terminal state cannot change");
      },
      this.now(),
    );
  }
}
