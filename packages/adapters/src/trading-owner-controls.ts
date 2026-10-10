import { TradingLiveStatusSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import { BrokerStateSchema } from "./broker-state.js";

/** A sent request younger than this may still be awaiting its provider acknowledgement. */
export const ABANDON_IN_FLIGHT_MS = 120_000;

/** Human-only product enablement and conservative abandonment of ambiguous attribution. */
export class TradingOwnerControls {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async liveSettings(ownerUserId: string) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const settings = await this.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    return { enabled: settings.tradingLiveEnabled };
  }
  async setLiveEnabled(ownerUserId: string, enabled: boolean) {
    await requireTradingOwner(this.prisma, ownerUserId);
    return this.prisma.$transaction(async (tx) => {
      await tx.deploymentSettings.update({
        where: { id: "default" },
        data: { tradingLiveEnabled: enabled },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId: "deployment",
          mode: "LIVE",
          event: "OWNER_LIVE_PRODUCT_ENABLEMENT",
          entry: { version: 1, enabled },
        },
      });
      // Enablement is one condition only; backend readiness still admits each action independently.
      return { enabled };
    });
  }
  /**
   * The owner has checked the broker directly. Rakazo still makes no claim about the outcome:
   * the effect is retired as unknown, every LIVE authority on the account is cancelled, and a
   * fresh snapshot must be adopted through drift reconciliation before any new mandate.
   */
  async abandonUncertainEffect(ownerUserId: string, effectId: string) {
    await requireTradingOwner(this.prisma, ownerUserId);
    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.tradingProviderExecution.findUniqueOrThrow({
        where: { effectId },
      });
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${execution.accountId} FOR UPDATE`;
      const current = await tx.tradingProviderExecution.findUniqueOrThrow({ where: { effectId } });
      const now = this.now();
      if (
        current.ownerUserId !== ownerUserId ||
        !(
          current.status === "UNCERTAIN" ||
          (current.status === "SENT" &&
            current.sentAt &&
            now.getTime() - current.sentAt.getTime() >= ABANDON_IN_FLIGHT_MS)
        )
      )
        throw new Error("Only a settled-in-time uncertain LIVE effect can be abandoned");
      const outcome = {
        version: 1,
        status: "UNCERTAIN",
        providerReference: null,
        code: "OWNER_ABANDONED_UNKNOWN_OUTCOME",
      };
      await tx.tradingProviderExecution.update({
        where: { effectId },
        data: { status: "RESOLVED", outcome, reconciledAt: now },
      });
      await tx.externalEffect.update({
        where: { id: effectId },
        data: { status: "abandoned", result: outcome, financialFailureCode: outcome.code },
      });
      await tx.tradingRiskReservation.updateMany({
        where: { effectId, status: { in: ["RESERVED", "UNCERTAIN"] } },
        data: { status: "RELEASED" },
      });
      await tx.tradingMandate.updateMany({
        where: {
          accountId: current.accountId,
          mode: "LIVE",
          status: { notIn: ["CANCELLED", "EXPIRED"] },
        },
        data: { status: "CANCELLED", revision: { increment: 1 } },
      });
      await tx.tradingPositionSupervision.updateMany({
        where: { accountId: current.accountId, status: { not: "CLOSED" } },
        data: { status: "CLOSED" },
      });
      if (
        !(await tx.tradingDriftEvent.count({
          where: { accountId: current.accountId, resolvedAt: null },
        }))
      )
        await tx.tradingDriftEvent.create({
          data: {
            ownerUserId,
            accountId: current.accountId,
            reason: "OWNER_ABANDONED_UNCERTAIN_EFFECT",
            evidence: { version: 1, effectId, clientId: current.clientId },
          },
        });
      await tx.financialJournal.create({
        data: {
          ownerUserId,
          accountId: current.accountId,
          mode: "LIVE",
          effectId,
          event: "OWNER_ABANDONED_UNCERTAIN_EFFECT",
          entry: { version: 1, clientId: current.clientId, previousStatus: current.status },
        },
      });
      return { effectId, accountId: current.accountId, requiresReconciliation: true as const };
    });
  }
  /** Owner-only projection of what blocks LIVE admission; health is never owner-attested. */
  async liveStatus(ownerUserId: string) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const [settings, runtime, connections, drift, effects] = await Promise.all([
      this.prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }),
      this.prisma.tradingRuntimeHealth.findUnique({ where: { id: "default" } }),
      this.prisma.tradingConnection.findMany({
        where: { ownerUserId, revokedAt: null },
        include: { lease: true },
        orderBy: { createdAt: "asc" },
        take: 32,
      }),
      this.prisma.tradingDriftEvent.findMany({
        where: { ownerUserId, resolvedAt: null },
        orderBy: { createdAt: "asc" },
        take: 64,
      }),
      this.prisma.tradingProviderExecution.findMany({
        where: { ownerUserId, status: { in: ["SENT", "UNCERTAIN"] } },
        orderBy: { createdAt: "asc" },
        take: 64,
      }),
    ]);
    const snapshots = await this.prisma.tradingBrokerSnapshot.findMany({
      where: { accountId: { in: connections.map((row) => row.id) } },
      select: { accountId: true, revision: true, observedAt: true },
    });
    const now = this.now();
    const fresh = (value: Date | null | undefined, age: number) =>
      !!value && now.getTime() - value.getTime() <= age;
    return TradingLiveStatusSchema.parse({
      enabled: settings.tradingLiveEnabled,
      runtime: {
        fresh: fresh(runtime?.observedAt, 15000),
        containment: runtime?.containmentActive === true,
        risk: runtime?.riskHealthy === true,
        effects: runtime?.effectsHealthy === true,
        emergencyStop: runtime?.emergencyStopHealthy === true,
        observability: runtime?.observabilityHealthy === true,
        schema: runtime?.schemaHealthy === true,
        observedAt: runtime?.observedAt.toISOString() ?? null,
      },
      accounts: connections.map((row) => {
        const snapshot = snapshots.find((item) => item.accountId === row.id);
        return {
          accountId: row.id,
          label: row.label,
          environment:
            row.environment === "REAL" || row.environment === "DEMO" ? row.environment : null,
          connected:
            row.lease?.state === "CONNECTED" &&
            row.lease.credentialVersion === row.credentialVersion &&
            fresh(row.lease.lastHealthyAt, 15000),
          snapshotRevision: snapshot?.revision ?? null,
          snapshotFresh: fresh(snapshot?.observedAt, 15000),
          drift: drift
            .filter((item) => item.accountId === row.id)
            .map((item) => ({
              id: item.id,
              reason: item.reason,
              createdAt: item.createdAt.toISOString(),
            })),
          uncertainEffects: effects
            .filter((item) => item.accountId === row.id)
            .map((item) => ({
              effectId: item.effectId,
              status: item.status as "SENT" | "UNCERTAIN",
              sentAt: item.sentAt?.toISOString() ?? null,
              abandonable:
                item.status === "UNCERTAIN" ||
                (!!item.sentAt && now.getTime() - item.sentAt.getTime() >= ABANDON_IN_FLIGHT_MS),
            })),
        };
      }),
    });
  }
  async reconcileDrift(ownerUserId: string, accountId: string, expectedRevision: number) {
    await requireTradingOwner(this.prisma, ownerUserId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${accountId} FOR UPDATE`;
      const connection = await tx.tradingConnection.findFirstOrThrow({
        where: { id: accountId, ownerUserId, revokedAt: null },
      });
      const snapshot = await tx.tradingBrokerSnapshot.findUniqueOrThrow({ where: { accountId } });
      const lease = await tx.brokerSessionLease.findUniqueOrThrow({ where: { accountId } });
      if (
        snapshot.revision !== expectedRevision ||
        snapshot.generation !== lease.generation ||
        lease.state !== "CONNECTED" ||
        this.now().getTime() - snapshot.observedAt.getTime() > 15000
      )
        throw new Error("Exact fresh reconciliation snapshot required");
      if (
        await tx.tradingProviderExecution.count({
          where: { accountId, status: { not: "RESOLVED" } },
        })
      )
        throw new Error("Unresolved provider effects must be reconciled first");
      const state = BrokerStateSchema.parse(snapshot);
      const drift = await tx.tradingDriftEvent.findMany({ where: { accountId, resolvedAt: null } });
      if (!drift.length) throw new Error("No drift to reconcile");
      // Never adopt manual edits into an existing approval. Cancel prior authority and require a new proposal.
      await tx.tradingMandate.updateMany({
        where: { accountId, mode: "LIVE", status: { notIn: ["CANCELLED", "EXPIRED"] } },
        data: { status: "CANCELLED", revision: { increment: 1 } },
      });
      await tx.tradingPositionSupervision.updateMany({
        where: { accountId, status: { not: "CLOSED" } },
        data: { status: "CLOSED" },
      });
      await tx.tradingRiskReservation.updateMany({
        where: { accountId, mode: "LIVE", status: "COMMITTED" },
        data: { status: "RELEASED" },
      });
      const now = this.now();
      await tx.tradingDriftEvent.updateMany({
        where: { id: { in: drift.map((row) => row.id) }, resolvedAt: null },
        data: { resolvedAt: now },
      });
      await tx.financialJournal.create({
        data: {
          ownerUserId: connection.ownerUserId,
          accountId,
          mode: "LIVE",
          event: "OWNER_DRIFT_RECONCILED_AUTHORITY_CANCELLED",
          entry: {
            version: 1,
            snapshotRevision: expectedRevision,
            generation: snapshot.generation,
            driftIds: drift.map((row) => row.id),
            baseline: state,
          },
        },
      });
      return { accountId, revision: expectedRevision, requiresNewMandate: true as const };
    });
  }
}
