import { createHash } from "node:crypto";
import type { FinancialAction, FinancialRiskFacts } from "@rakazo/contracts";
import {
  TradingCapabilitiesSchema,
  TradingGoalInputSchema,
  TradingMandateEnvelopeSchema,
} from "@rakazo/contracts";
import { mandateActionAuthority } from "@rakazo/core";
import { tradingMandateFingerprint } from "@rakazo/core/node/financial-action";
import type { Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const fresh = (value: Date | string | null | undefined, now: Date, age: number) => {
  if (!value) return false;
  const delta = now.getTime() - new Date(value).getTime();
  return delta >= -2000 && delta <= age;
};

/** Backend-only admission check, evaluated under the account lock at reservation and dispatch. */
export async function liveReadiness(
  tx: Prisma.TransactionClient,
  input: {
    ownerUserId: string;
    botId: string;
    mandateId: string;
    action: FinancialAction;
    facts: FinancialRiskFacts;
    effectId?: string;
    now: Date;
  },
) {
  const { action, facts, now } = input;
  const failures: string[] = [];
  const check = (ok: unknown, code: string) => {
    if (!ok) failures.push(code);
  };
  const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
  const connection = await tx.tradingConnection.findUnique({ where: { id: action.accountId } });
  const lease = await tx.brokerSessionLease.findUnique({ where: { accountId: action.accountId } });
  const snapshot = await tx.tradingBrokerSnapshot.findUnique({
    where: { accountId: action.accountId },
  });
  const runtime = await tx.tradingRuntimeHealth.findUnique({ where: { id: "default" } });
  const mandate = await tx.tradingMandate.findUnique({ where: { id: input.mandateId } });
  const instrument = await tx.brokerInstrument.findUnique({ where: { id: action.instrumentId } });
  const computers = await tx.computer.findMany({
    where: { userId: input.ownerUserId, spaceId: settings?.ownerSpaceId ?? "" },
    select: { id: true, kind: true, providerRef: true },
    orderBy: { id: "asc" },
  });
  const containmentScopeFingerprint = createHash("sha256")
    .update(JSON.stringify(computers))
    .digest("hex");
  check(
    action.mode === "LIVE" &&
      settings?.tradingLiveEnabled &&
      settings.ownerUserId === input.ownerUserId &&
      settings.ownerBootstrapCompleted &&
      settings.singleOwnerEnforced,
    "OWNER_LIVE_DISABLED",
  );
  check(
    connection?.ownerUserId === input.ownerUserId &&
      !connection?.revokedAt &&
      connection?.verifiedAt &&
      connection.provider === action.provider,
    "ACCOUNT_UNVERIFIED",
  );
  check(
    lease?.state === "CONNECTED" &&
      lease.expiresAt &&
      lease.expiresAt > now &&
      lease.credentialVersion === connection?.credentialVersion &&
      fresh(lease.lastHealthyAt, now, 15000),
    "PROVIDER_CONNECTION_UNHEALTHY",
  );
  const capabilities = TradingCapabilitiesSchema.safeParse(connection?.capabilities);
  check(
    capabilities.success &&
      capabilities.data.accountId === action.accountId &&
      capabilities.data.provider === action.provider &&
      capabilities.data.operations.includes(action.operation) &&
      (action.operation !== "OPEN" || capabilities.data.orderTypes.includes(action.orderType)),
    "CAPABILITY_UNAVAILABLE",
  );
  check(
    instrument?.active &&
      instrument.accountId === action.accountId &&
      instrument.brokerSymbol === action.brokerSymbol &&
      instrument.specification &&
      fresh(instrument.verifiedAt, now, 600000),
    "SYMBOL_SPECIFICATION_UNVERIFIED",
  );
  check(
    snapshot &&
      snapshot.generation === lease?.generation &&
      fresh(snapshot.observedAt, now, 15000) &&
      facts.accountId === action.accountId &&
      fresh(facts.observedAt, now, 15000),
    "ACCOUNT_STATE_STALE",
  );
  check(facts.accountMode === "HEDGING", "NETTING_ATTRIBUTION_UNSAFE");
  if (action.operation === "OPEN" && snapshot) {
    const known = await tx.tradingRiskReservation.findMany({
      where: { accountId: action.accountId, mode: "LIVE", status: "COMMITTED", kind: "POSITION" },
      select: { providerReference: true },
    });
    const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
    check(
      positions.every(
        (row) =>
          row &&
          typeof row === "object" &&
          "id" in row &&
          known.some((reservation) => reservation.providerReference === row.id),
      ),
      "UNATTRIBUTED_EXPOSURE",
    );
  }
  check(
    facts.instrumentId === action.instrumentId &&
      facts.brokerSymbol === action.brokerSymbol &&
      facts.quote.accountId === action.accountId &&
      facts.quote.instrumentId === action.instrumentId &&
      fresh(facts.quote.sourceTime, now, 15000) &&
      fresh(facts.quote.receivedAt, now, 15000),
    "PRICE_STATE_STALE",
  );
  check(runtime && fresh(runtime.observedAt, now, 15000), "RUNTIME_HEALTH_STALE");
  check(runtime?.riskHealthy, "RISK_ENGINE_UNHEALTHY");
  check(runtime?.effectsHealthy, "EFFECT_SYSTEM_UNHEALTHY");
  check(runtime?.emergencyStopHealthy, "EMERGENCY_STOP_UNHEALTHY");
  check(
    runtime?.containmentActive &&
      runtime.containmentRevision === "financial-egress-v1" &&
      runtime.containmentScopeFingerprint === containmentScopeFingerprint &&
      computers.every((computer) => computer.kind === "docker"),
    "FINANCIAL_CONTAINMENT_UNVERIFIED",
  );
  check(
    runtime?.observabilityHealthy && runtime.jobLagMs !== null && runtime.jobLagMs <= 30000,
    "OBSERVABILITY_UNHEALTHY",
  );
  const migrations = await tx.$queryRaw<
    Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
  >`
    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
    WHERE migration_name = '202610100004_live_runtime_readiness'
       OR (finished_at IS NULL AND rolled_back_at IS NULL)`;
  check(
    migrations.some(
      (row) => row.migration_name === "202610100004_live_runtime_readiness" && row.finished_at,
    ) && !migrations.some((row) => !row.finished_at && !row.rolled_back_at),
    "DATABASE_MIGRATIONS_UNHEALTHY",
  );
  const unresolved = await tx.externalEffect.count({
    where: {
      ...(input.effectId ? { id: { not: input.effectId } } : {}),
      status: { in: ["executing", "uncertain", "reconciling"] },
      AND: [
        { financialContext: { path: ["accountId"], equals: action.accountId } },
        { financialContext: { path: ["mode"], equals: "LIVE" } },
      ],
    },
  });
  check(!unresolved, "UNRESOLVED_FINANCIAL_EFFECT");
  check(
    !(await tx.tradingDriftEvent.count({
      where: { accountId: action.accountId, resolvedAt: null },
    })),
    "UNRESOLVED_MANUAL_DRIFT",
  );
  const envelope = TradingMandateEnvelopeSchema.safeParse(mandate?.envelope);
  if (action.operation === "OPEN") {
    check(fresh(mandate?.observedAt, now, 15000), "MISSION_ACCOUNTING_STALE");
    if (envelope.success && envelope.data.maxDailyLoss !== null)
      check(
        mandate?.approvedAt?.toISOString().slice(0, 10) === now.toISOString().slice(0, 10),
        "DAILY_ACCOUNTING_BASELINE_REQUIRED",
      );
  }
  const goal = mandate ? await tx.tradingGoal.findUnique({ where: { id: mandate.goalId } }) : null;
  const definition = TradingGoalInputSchema.safeParse(goal?.definition);
  const authority =
    mandate && envelope.success && definition.success
      ? mandateActionAuthority({
          status: mandate.status,
          envelope: envelope.data,
          action,
          startsAt: definition.data.startsAt,
          endsAt: definition.data.endsAt,
          now,
        })
      : null;
  check(
    mandate &&
      envelope.success &&
      mandate.ownerUserId === input.ownerUserId &&
      mandate.botId === input.botId &&
      mandate.accountId === action.accountId &&
      mandate.mode === "LIVE" &&
      mandate.approvedByUserId === input.ownerUserId &&
      mandate.approvedAt &&
      authority &&
      envelope.data.botId === input.botId &&
      envelope.data.ownerId === input.ownerUserId &&
      envelope.data.accountId === action.accountId &&
      envelope.data.mode === "LIVE" &&
      mandate.fingerprint === tradingMandateFingerprint(envelope.data) &&
      mandate.approvedFingerprint === mandate.fingerprint &&
      mandate.expiresAt.getTime() === Date.parse(envelope.data.expiresAt),
    "EXACT_LIVE_MANDATE_REQUIRED",
  );
  return { ready: failures.length === 0, failures };
}

export async function requireLiveReadiness(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof liveReadiness>[1],
) {
  const readiness = await liveReadiness(tx, input);
  if (!readiness.ready) {
    getLogger().warn("LIVE readiness denied", { failures: readiness.failures });
    throw new Error(`LIVE trading disabled: ${readiness.failures.join(",")}`);
  }
}
