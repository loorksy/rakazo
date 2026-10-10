import { selectPlaybook } from "@rakazo/core";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DeploymentConfigConflictError,
  DeploymentConfigService,
  readDeploymentConfig,
} from "./deployment-config.js";
import { createSecretStore } from "./secret-store-factory.js";

const url = process.env.DEPLOYMENT_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const owner = "fixture-owner";
const token = "fixture-axiom-sentinel";

suite("owner deployment settings", () => {
  let db: ReturnType<typeof createDb>;
  let service: DeploymentConfigService;
  const reset = () =>
    db.prisma
      .$executeRaw`TRUNCATE deployment_config, deployment_config_audit, service_runtime_reports, integration_provider_configs, deployment_settings, trading_runtime_health CASCADE`;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("Dedicated fixture _test database required");
    db = createDb(url);
    const secrets = createSecretStore("ab".repeat(32), { SECRET_STORE: "encrypted" });
    await secrets.start();
    service = new DeploymentConfigService(db.prisma, secrets, {
      DATABASE_URL: "postgres://rakazo:secret@127.0.0.1/rakazo",
      POSTGRES_PASSWORD: "secret",
      BETTER_AUTH_SECRET: "replace-with-32-plus-character-secret",
      ENCRYPTION_KEY: "ab".repeat(32),
      SANDBOX_COMPUTER_EGRESS: "financial",
    });
  });
  beforeEach(reset);
  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it("rejects a stale revision and never returns a stored credential", async () => {
    const first = await service.view();
    await expect(
      service.update(owner, {
        expectedRevision: first.revision + 1,
        runtime: { logLevel: "warn" },
      }),
    ).rejects.toBeInstanceOf(DeploymentConfigConflictError);
    const saved = await service.setSecret(owner, {
      expectedRevision: first.revision,
      key: "observability.axiomToken",
      value: token,
    });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(saved.secrets.find((row) => row.key === "observability.axiomToken")).toMatchObject({
      configured: true,
      source: "owner",
    });
    expect(saved.bootstrap.map((row) => row.name)).toContain("DATABASE_URL");
    expect(JSON.stringify(saved.bootstrap)).not.toContain("postgres://");
    expect(saved.bootstrap.find((row) => row.name === "BETTER_AUTH_SECRET")?.status).toBe(
      "PLACEHOLDER",
    );
  });
  it("applies a disabled playbook family without disabling safety rules", async () => {
    const view = await service.playbook();
    const next = await service.setPlaybook(owner, {
      expectedRevision: view.revision,
      disabledGroups: ["retest"],
    });
    expect(next.groups.find((group) => group.id === "retest")?.enabled).toBe(false);
    const stored = await readDeploymentConfig(db.prisma);
    const selected = selectPlaybook({
      symbol: "EURUSD",
      news: "PRE",
      disabledGroups: stored.playbookDisabledGroups,
    });
    expect(selected.rules.some((rule) => rule.group === "retest")).toBe(false);
    expect(selected.rules.map((rule) => rule.id)).toContain("NEWS.FREEZE");
  });
  it("reports a restart only for a service still running the previous value", async () => {
    const now = new Date();
    await db.prisma.serviceRuntimeReport.create({
      data: {
        instanceId: "worker:fixture",
        service: "worker",
        startedAt: now,
        heartbeatAt: now,
        revision: 0,
        applied: { graphileWorkerConcurrency: "4" },
      },
    });
    const current = await service.view();
    const saved = await service.update(owner, {
      expectedRevision: current.revision,
      runtime: { graphileWorkerConcurrency: 8, computerMemory: "4g" },
    });
    expect(
      saved.settings.find((row) => row.key === "graphileWorkerConcurrency")?.restartRequired,
    ).toEqual(["worker"]);
    expect(saved.settings.find((row) => row.key === "computerMemory")?.restartRequired).toEqual([]);
    expect(saved.settings.find((row) => row.key === "computerMemory")?.apply).toBe("NEW_COMPUTERS");
  });
});
