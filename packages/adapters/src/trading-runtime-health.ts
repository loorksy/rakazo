import { createHash } from "node:crypto";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { financialDecimal, financialUnits } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { Logger } from "@rakazo/logging";

/** Trusted Worker liveness and actual supervisor inspection. No UI or Agent can attest health. */
export class TradingRuntimeHealthProbe {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sandbox: SandboxProvider,
    private readonly workerHealth: () => { active: boolean; streams: number },
    private readonly logger: Logger,
  ) {}
  start() {
    const poll = () => {
      if (this.running) return;
      this.running = this.tick()
        .catch(() => undefined)
        .finally(() => {
          this.running = undefined;
        });
    };
    this.timer = setInterval(poll, 5000);
    this.timer.unref();
    poll();
  }
  async close() {
    clearInterval(this.timer);
    await this.running;
    await this.prisma.tradingRuntimeHealth.updateMany({
      data: { containmentActive: false, effectsHealthy: false },
    });
  }
  async tick() {
    const settings = await this.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    if (!settings?.ownerUserId || !settings.ownerSpaceId) return;
    const computers = await this.prisma.computer.findMany({
      where: { userId: settings.ownerUserId, spaceId: settings.ownerSpaceId },
      select: { id: true, kind: true, providerRef: true },
      orderBy: { id: "asc" },
    });
    const evidence = await this.sandbox
      .financialContainment?.({
        userId: settings.ownerUserId,
        spaceId: settings.ownerSpaceId,
        operationId: "trading.runtime.health",
        traceId: "trading.runtime.health",
        signal: AbortSignal.timeout(4000),
      })
      .catch(() => undefined);
    const age = evidence ? Date.now() - Date.parse(evidence.checkedAt) : Number.POSITIVE_INFINITY;
    const containmentActive =
      evidence?.active === true &&
      evidence.revision === "financial-egress-v1" &&
      age >= -2000 &&
      age <= 5000 &&
      computers.every((c) => c.kind === "docker");
    const worker = this.workerHealth();
    const database = await this.prisma.$queryRaw<Array<{ effects: boolean; emergency: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'preserve_live_execution') AS effects,
        has_table_privilege(current_user, 'account_risk_guardrails', 'UPDATE') AS emergency`;
    const job = await this.prisma.$queryRaw<Array<{ lag: number }>>`
      SELECT COALESCE(MAX(GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - run_at))*1000)), 0)::float8 AS lag
      FROM graphile_worker.jobs WHERE run_at < CURRENT_TIMESTAMP AND locked_at IS NULL AND attempts < max_attempts`.catch(
      () => null,
    );
    const leases = await this.prisma.brokerSessionLease.findMany({
      select: {
        state: true,
        generation: true,
        reconnectCount: true,
        lastEventAt: true,
        lastHealthyAt: true,
      },
    });
    const snapshots = await this.prisma.tradingBrokerSnapshot.aggregate({
      _min: { observedAt: true },
    });
    const unresolved = await this.prisma.externalEffect.aggregate({
      where: {
        status: { in: ["executing", "uncertain", "reconciling"] },
        financialStartedAt: { not: null },
      },
      _count: true,
      _min: { financialStartedAt: true },
    });
    const activeMandates = await this.prisma.tradingMandate.count({ where: { status: "ACTIVE" } });
    const pausedSupervisions = await this.prisma.tradingPositionSupervision.count({
      where: { status: "PAUSED" },
    });
    const unresolvedDrift = await this.prisma.tradingDriftEvent.count({
      where: { resolvedAt: null },
    });
    const failedReservations = await this.prisma.financialJournal.count({
      where: { event: "RISK_DENIED", createdAt: { gt: new Date(Date.now() - 60000) } },
    });
    const oldest = (values: Array<Date | null>) =>
      Math.max(0, ...values.filter((v): v is Date => !!v).map((v) => Date.now() - v.getTime()));
    const effectsHealthy = worker.active && database[0]?.effects === true;
    const emergencyStopHealthy = database[0]?.emergency === true;
    // The engine is local deterministic code; exact decimal arithmetic must remain intact.
    const riskHealthy = financialDecimal(financialUnits("0.1") + financialUnits("0.2")) === "0.3";
    const jobLagMs = job ? Math.ceil(job[0]?.lag ?? 0) : null;
    const metrics = {
      connectedProviders: leases.filter((l) => l.state === "CONNECTED").length,
      reconnects: leases.reduce((n, l) => n + l.reconnectCount, 0),
      maxStreamFence: Math.max(0, ...leases.map((l) => l.generation)),
      streams: worker.streams,
      eventLagMs: oldest(leases.map((l) => l.lastEventAt)),
      connectionAgeMs: oldest(leases.map((l) => l.lastHealthyAt)),
      accountAgeMs: oldest([snapshots._min.observedAt]),
      unresolvedEffects: unresolved._count,
      reconciliationAgeMs: oldest([unresolved._min.financialStartedAt]),
      failedReservations,
      activeMandates,
      pausedSupervisions,
      unresolvedDrift,
      jobLagMs,
      containmentActive,
    };
    this.logger.info("trading operational health", metrics);
    await this.logger.flush({ timeoutMs: 1000 });
    const data = {
      containmentActive,
      containmentRevision: containmentActive ? "financial-egress-v1" : null,
      containmentScopeFingerprint: createHash("sha256")
        .update(JSON.stringify(computers))
        .digest("hex"),
      riskHealthy,
      effectsHealthy,
      emergencyStopHealthy,
      observabilityHealthy: worker.active && jobLagMs !== null && jobLagMs <= 30000,
      jobLagMs,
      observedAt: new Date(),
    };
    await this.prisma.tradingRuntimeHealth.upsert({
      where: { id: "default" },
      create: data,
      update: data,
    });
  }
}
