import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type {
  DeploymentConfigView,
  DeploymentRuntimeKey,
  DeploymentRuntimeSettings,
  DeploymentSecretKey,
  DeploymentService,
} from "@rakazo/contracts";
import {
  BOOTSTRAP_SECRET_NAMES,
  DEPLOYMENT_RUNTIME_SETTINGS,
  DEPLOYMENT_SECRETS,
  DeploymentConfigUpdateSchema,
  DeploymentConfigViewSchema,
  DeploymentRuntimeKeySchema,
  DeploymentRuntimeSettingsSchema,
  DeploymentSecretUpdateSchema,
  PlaybookGroupUpdateSchema,
  PlaybookSettingsViewSchema,
} from "@rakazo/contracts";
import {
  PLAYBOOK_GROUPS,
  resolveEncryptionKey,
  TRADING_PLAYBOOK,
  TRADING_PLAYBOOK_VERSION,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { calendarProvider, EconomicCalendarPoller } from "./economic-calendar.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { createSecretStore } from "./secret-store-factory.js";

/** Credentials share the owner-managed, lifecycle-tracked server provider table. */
export const deploymentSecretRecordId = (key: DeploymentSecretKey) => `deployment:${key}`;
const RUNTIME_KEYS = DeploymentRuntimeKeySchema.options;
const REPORT_FRESH_MS = 90_000;
const REFRESH_MS = 15_000;

export class DeploymentConfigConflictError extends Error {
  constructor() {
    super("Deployment settings changed; reload and try again");
    this.name = "DeploymentConfigConflictError";
  }
}

/** Invalid persisted entries are ignored rather than applied; the environment then decides. */
export function parseRuntimeSettings(raw: unknown): Partial<DeploymentRuntimeSettings> {
  const record = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!record.success) return {};
  const settings: Partial<DeploymentRuntimeSettings> = {};
  for (const key of RUNTIME_KEYS) {
    const parsed = DeploymentRuntimeSettingsSchema.shape[key].safeParse(record.data[key]);
    if (parsed.success && parsed.data !== null)
      Object.assign(settings, { [key]: parsed.data } satisfies Partial<DeploymentRuntimeSettings>);
  }
  return settings;
}

export async function readDeploymentConfig(prisma: PrismaClient) {
  const row = await prisma.deploymentConfig.findUnique({ where: { id: "default" } });
  const playbook = z
    .object({ disabledGroups: z.array(z.string().max(64)).max(64) })
    .safeParse(row?.playbook);
  return {
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null,
    runtime: parseRuntimeSettings(row?.runtime),
    playbookDisabledGroups: playbook.success ? playbook.data.disabledGroups : [],
  };
}

async function loadSecret(prisma: PrismaClient, secrets: SecretStore, key: DeploymentSecretKey) {
  const row = await prisma.integrationProviderConfig.findUnique({
    where: { id: deploymentSecretRecordId(key) },
  });
  if (!row) return undefined;
  return secrets.load(row.ciphertext, `integration-provider:${deploymentSecretRecordId(key)}`);
}

/**
 * Applies owner settings over the deployment environment for one process. Restart-scoped
 * settings are applied only at start; live settings refresh. The original environment is
 * retained so clearing a setting restores the operator's value.
 */
export class DeploymentRuntime {
  private readonly instanceId: string;
  private readonly baseline: Record<string, string | undefined> = {};
  private readonly startedAt = new Date();
  private applied: Record<string, string | null> = {};
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly service: DeploymentService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly gitSha: string | null = env.GIT_SHA?.trim() || null,
  ) {
    this.instanceId = `${service}:${randomUUID()}`;
    for (const key of RUNTIME_KEYS) {
      const name = DEPLOYMENT_RUNTIME_SETTINGS[key].env;
      this.baseline[name] = env[name];
    }
    for (const secret of Object.values(DEPLOYMENT_SECRETS))
      this.baseline[secret.env] = env[secret.env];
  }
  private set(name: string, value: string | number | undefined) {
    if (value === undefined) {
      if (this.baseline[name] === undefined) delete this.env[name];
      else this.env[name] = this.baseline[name];
    } else this.env[name] = String(value);
  }
  /** Returns the start-time values this process will report. */
  async apply(scope: "start" | "refresh") {
    const config = await readDeploymentConfig(this.prisma);
    this.revision = config.revision;
    for (const key of RUNTIME_KEYS) {
      const meta = DEPLOYMENT_RUNTIME_SETTINGS[key];
      if (scope === "refresh" && meta.apply === "RESTART") continue;
      this.set(meta.env, config.runtime[key] ?? undefined);
    }
    for (const [key, meta] of Object.entries(DEPLOYMENT_SECRETS) as Array<
      [DeploymentSecretKey, (typeof DEPLOYMENT_SECRETS)[DeploymentSecretKey]]
    >) {
      if (scope === "refresh" && meta.services.length) continue;
      this.set(meta.env, await loadSecret(this.prisma, this.secrets, key).catch(() => undefined));
    }
    if (scope === "start")
      this.applied = Object.fromEntries(
        RUNTIME_KEYS.filter((key) => DEPLOYMENT_RUNTIME_SETTINGS[key].apply === "RESTART").map(
          (key) => [key, this.env[DEPLOYMENT_RUNTIME_SETTINGS[key].env] ?? null],
        ),
      );
    return config;
  }
  private async report() {
    const now = new Date();
    await this.prisma.serviceRuntimeReport.upsert({
      where: { instanceId: this.instanceId },
      create: {
        instanceId: this.instanceId,
        service: this.service,
        startedAt: this.startedAt,
        heartbeatAt: now,
        revision: this.revision,
        applied: this.applied,
        gitSha: this.gitSha,
      },
      update: { heartbeatAt: now },
    });
    await this.prisma.serviceRuntimeReport.deleteMany({
      where: { heartbeatAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } },
    });
  }
  async start() {
    await this.apply("start");
    await this.report();
    this.timer = setInterval(() => {
      void this.apply("refresh")
        .then(() => this.report())
        .catch(() => undefined);
    }, REFRESH_MS);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await this.prisma.serviceRuntimeReport
      .delete({ where: { instanceId: this.instanceId } })
      .catch(() => undefined);
  }
}

const placeholder = (value: string) =>
  /^replace[-_]|replace-with|REPLACE_WITH|changeme/i.test(value);

/** Owner-only view and revision-checked edits. Secret values never leave this class. */
export class DeploymentConfigService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async view(): Promise<DeploymentConfigView> {
    const [config, stored, reports, runtime] = await Promise.all([
      readDeploymentConfig(this.prisma),
      this.prisma.integrationProviderConfig.findMany({
        where: {
          id: {
            in: Object.keys(DEPLOYMENT_SECRETS).map((key) =>
              deploymentSecretRecordId(key as DeploymentSecretKey),
            ),
          },
        },
        select: { id: true },
      }),
      this.prisma.serviceRuntimeReport.findMany({
        where: { heartbeatAt: { gte: new Date(this.now().getTime() - REPORT_FRESH_MS) } },
        orderBy: { startedAt: "desc" },
        take: 32,
      }),
      this.prisma.tradingRuntimeHealth.findUnique({ where: { id: "default" } }),
    ]);
    const live = reports.map((row) => ({
      service: row.service as DeploymentService,
      applied: z.record(z.string(), z.string().nullable()).catch({}).parse(row.applied),
    }));
    const environmentValue = (key: DeploymentRuntimeKey) => {
      const name = DEPLOYMENT_RUNTIME_SETTINGS[key].env;
      const reported = live.find((row) => row.applied[key] !== undefined)?.applied[key];
      return reported ?? this.env[name] ?? null;
    };
    const settings = RUNTIME_KEYS.map((key) => {
      const meta = DEPLOYMENT_RUNTIME_SETTINGS[key];
      const value = config.runtime[key] ?? null;
      const fallback = value === null ? environmentValue(key) : null;
      const effective = value ?? fallback;
      return {
        key,
        env: meta.env,
        value,
        effective,
        source:
          value !== null
            ? ("owner" as const)
            : fallback
              ? ("environment" as const)
              : ("default" as const),
        apply: meta.apply,
        restartRequired:
          meta.apply === "RESTART"
            ? [
                ...new Set(
                  live
                    .filter(
                      (row) =>
                        meta.services.includes(row.service) &&
                        value !== null &&
                        row.applied[key] !== String(value),
                    )
                    .map((row) => row.service),
                ),
              ]
            : [],
      };
    });
    const configured = new Set(stored.map((row) => row.id));
    const secrets = (Object.keys(DEPLOYMENT_SECRETS) as DeploymentSecretKey[]).map((key) => {
      const owner = configured.has(deploymentSecretRecordId(key));
      const environment = !!this.env[DEPLOYMENT_SECRETS[key].env]?.trim();
      return {
        key,
        configured: owner || environment,
        source: owner
          ? ("owner" as const)
          : environment
            ? ("environment" as const)
            : ("none" as const),
        restartRequired: [] as DeploymentService[],
      };
    });
    const bootstrap = BOOTSTRAP_SECRET_NAMES.map((name) => {
      const value = this.env[name]?.trim();
      if (name === "DATABASE_URL") return { name, status: "CONFIGURED" as const };
      if (value === undefined) return { name, status: "UNKNOWN" as const };
      if (!value) return { name, status: "MISSING" as const };
      return {
        name,
        status: placeholder(value) ? ("PLACEHOLDER" as const) : ("CONFIGURED" as const),
      };
    });
    const mode = runtime?.containmentMode;
    return DeploymentConfigViewSchema.parse({
      revision: config.revision,
      updatedAt: config.updatedAt?.toISOString() ?? null,
      settings,
      secrets,
      bootstrap,
      containment: {
        mode: mode === "open" || mode === "restricted" || mode === "financial" ? mode : null,
        verified: runtime?.containmentActive === true,
        observedAt: runtime?.observedAt.toISOString() ?? null,
      },
      services: reports.map((row) => ({
        service: row.service,
        startedAt: row.startedAt.toISOString(),
        heartbeatAt: row.heartbeatAt.toISOString(),
        revision: row.revision,
        gitSha: row.gitSha,
      })),
    });
  }
  async update(actorUserId: string, raw: unknown) {
    const input = DeploymentConfigUpdateSchema.parse(raw);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO deployment_config (id, "updatedAt") VALUES ('default', CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
      const [row] = await tx.$queryRaw<Array<{ revision: number; runtime: unknown }>>`
        SELECT revision, runtime FROM deployment_config WHERE id = 'default' FOR UPDATE`;
      if (!row || row.revision !== input.expectedRevision)
        throw new DeploymentConfigConflictError();
      const before = parseRuntimeSettings(row.runtime);
      const after: Partial<DeploymentRuntimeSettings> = { ...before };
      const changes: Array<{
        key: string;
        from: string | number | null;
        to: string | number | null;
      }> = [];
      for (const key of RUNTIME_KEYS) {
        if (!(key in input.runtime)) continue;
        const next = input.runtime[key] ?? null;
        const previous = before[key] ?? null;
        if (next === previous) continue;
        if (next === null) delete after[key];
        else Object.assign(after, { [key]: next });
        changes.push({ key, from: previous, to: next });
      }
      if (!changes.length) return;
      await tx.deploymentConfig.update({
        where: { id: "default" },
        data: { runtime: after, revision: { increment: 1 }, updatedByUserId: actorUserId },
      });
      await tx.deploymentConfigAudit.create({
        data: {
          revision: row.revision + 1,
          actorUserId,
          changes: { version: 1, runtime: changes },
        },
      });
    });
    return this.view();
  }
  async setSecret(actorUserId: string, raw: unknown) {
    const input = DeploymentSecretUpdateSchema.parse(raw);
    const id = deploymentSecretRecordId(input.key);
    const stored = input.value
      ? await this.secrets.put(
          input.value,
          {
            userId: actorUserId,
            spaceId: "deployment",
            operationId: "deployment.secret.save",
            traceId: id,
            signal: AbortSignal.timeout(10000),
          },
          { recordId: `integration-provider:${id}` },
        )
      : undefined;
    await persistPreparedSecret(
      this.prisma,
      this.secrets,
      stored ? { id: `integration-provider:${id}`, ciphertext: stored.ref } : undefined,
      () =>
        this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO deployment_config (id, "updatedAt") VALUES ('default', CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
          const [row] = await tx.$queryRaw<Array<{ revision: number }>>`
            SELECT revision FROM deployment_config WHERE id = 'default' FOR UPDATE`;
          if (!row || row.revision !== input.expectedRevision)
            throw new DeploymentConfigConflictError();
          if (stored)
            await tx.integrationProviderConfig.upsert({
              where: { id },
              create: { id, ciphertext: stored.ref },
              update: { ciphertext: stored.ref },
            });
          else await tx.integrationProviderConfig.deleteMany({ where: { id } });
          await tx.deploymentConfig.update({
            where: { id: "default" },
            data: { revision: { increment: 1 }, updatedByUserId: actorUserId },
          });
          await tx.deploymentConfigAudit.create({
            data: {
              revision: row.revision + 1,
              actorUserId,
              changes: { version: 1, secret: input.key, action: stored ? "SET" : "REMOVED" },
            },
          });
        }),
    );
    return this.view();
  }
  async playbook() {
    const config = await readDeploymentConfig(this.prisma);
    const disabled = new Set(config.playbookDisabledGroups);
    return PlaybookSettingsViewSchema.parse({
      version: TRADING_PLAYBOOK_VERSION,
      revision: config.revision,
      groups: PLAYBOOK_GROUPS.map(([id, label]) => ({
        id,
        label,
        enabled: !disabled.has(id),
        rules: TRADING_PLAYBOOK.filter((rule) => rule.group === id).length,
      })),
    });
  }
  async setPlaybook(actorUserId: string, raw: unknown) {
    const input = PlaybookGroupUpdateSchema.parse(raw);
    const disabledGroups = [...new Set(input.disabledGroups)];
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO deployment_config (id, "updatedAt") VALUES ('default', CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
      const [row] = await tx.$queryRaw<Array<{ revision: number }>>`
        SELECT revision FROM deployment_config WHERE id = 'default' FOR UPDATE`;
      if (!row || row.revision !== input.expectedRevision)
        throw new DeploymentConfigConflictError();
      await tx.deploymentConfig.update({
        where: { id: "default" },
        data: {
          playbook: { disabledGroups },
          revision: { increment: 1 },
          updatedByUserId: actorUserId,
        },
      });
      await tx.deploymentConfigAudit.create({
        data: {
          revision: row.revision + 1,
          actorUserId,
          changes: { version: 1, playbook: { disabledGroups } },
        },
      });
    });
    return this.playbook();
  }
  async calendarStatus() {
    const provider = calendarProvider();
    const configured = Boolean(process.env.ECONOMIC_CALENDAR_API_KEY?.trim());
    if (!provider || !configured)
      return { provider, configured, status: "DISABLED" as const, events: 0 };
    try {
      await new EconomicCalendarPoller(this.prisma, getLogger()).tick();
      return {
        provider,
        configured: true,
        status: "OK" as const,
        events: await this.prisma.economicCalendarEvent.count(),
      };
    } catch {
      return { provider, configured: true, status: "UNAVAILABLE" as const, events: 0 };
    }
  }
}

/**
 * Composition-root helper: applies owner settings before the process creates its logger or
 * job runner, then keeps live settings and the runtime report fresh. Never throws; the
 * deployment environment remains authoritative when the database is unavailable.
 */
export async function startDeploymentRuntime(
  service: DeploymentService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ close(): Promise<void>; error?: string }> {
  if (!env.DATABASE_URL) return { close: async () => {}, error: "DATABASE_URL is not set" };
  let db: ReturnType<typeof createDb> | undefined;
  let secrets: SecretStore | undefined;
  try {
    db = createDb(env.DATABASE_URL, { poolMax: 1, applicationName: `rakazo-${service}-config` });
    secrets = createSecretStore(resolveEncryptionKey(env), env);
    await secrets.start();
    const runtime = new DeploymentRuntime(db.prisma, secrets, service, env);
    await runtime.start();
    const opened = { db, secrets };
    return {
      close: async () => {
        await runtime.close();
        await opened.secrets.close().catch(() => undefined);
        await opened.db.prisma.$disconnect().catch(() => undefined);
        await opened.db.pool.end().catch(() => undefined);
      },
    };
  } catch {
    await secrets?.close().catch(() => undefined);
    await db?.prisma.$disconnect().catch(() => undefined);
    await db?.pool.end().catch(() => undefined);
    return { close: async () => {}, error: "Owner deployment settings could not be loaded" };
  }
}
