import type { PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import { BrokerStateSchema } from "./broker-state.js";

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
