import * as z from "zod";

const Timestamp = z.iso.datetime({ offset: true });
const memoryMegabytes = (value: string) => {
  const match = /^(\d{1,5}(?:\.\d{1,2})?)([mg])$/i.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * (match[2]!.toLowerCase() === "g" ? 1024 : 1);
};

/**
 * Owner-adjustable deployment settings. This is an allowlist: bootstrap identity secrets,
 * database/auth/encryption keys, supervisor tokens and containment mode are never here.
 */
export const DeploymentRuntimeSettingsSchema = z.strictObject({
  computerMemory: z
    .string()
    .trim()
    .refine((value) => {
      const megabytes = memoryMegabytes(value);
      return megabytes >= 256 && megabytes <= 65536;
    }, "Use 256m to 64g")
    .nullable(),
  computerCpus: z
    .string()
    .trim()
    .regex(/^\d{1,2}(?:\.\d{1,2})?$/)
    .refine((value) => Number(value) >= 0.5 && Number(value) <= 32, "Use 0.5 to 32")
    .nullable(),
  computerPidsLimit: z.number().int().min(256).max(65536).nullable(),
  sandboxIdleMs: z.number().int().min(30_000).max(86_400_000).nullable(),
  /** 0 keeps the per-turn tool-call fuse off. */
  maxToolCallsPerTurn: z.number().int().min(0).max(1000).nullable(),
  graphileWorkerConcurrency: z.number().int().min(1).max(32).nullable(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).nullable(),
  axiomDataset: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,128}$/)
    .nullable(),
  economicCalendarProvider: z.enum(["fmp", "finnhub"]).nullable(),
});
export type DeploymentRuntimeSettings = z.infer<typeof DeploymentRuntimeSettingsSchema>;
export type DeploymentRuntimeKey = keyof DeploymentRuntimeSettings;
export const DeploymentRuntimeKeySchema = z.enum(
  Object.keys(DeploymentRuntimeSettingsSchema.shape) as [
    DeploymentRuntimeKey,
    ...DeploymentRuntimeKey[],
  ],
);

export type DeploymentService = "api" | "worker";
/** How a change takes effect. Nothing pretends a process-local change reached every service. */
export const DEPLOYMENT_RUNTIME_SETTINGS: Record<
  DeploymentRuntimeKey,
  {
    env: string;
    apply: "LIVE" | "RESTART" | "NEW_COMPUTERS";
    services: DeploymentService[];
  }
> = {
  computerMemory: { env: "RAKAZO_COMPUTER_MEMORY", apply: "NEW_COMPUTERS", services: [] },
  computerCpus: { env: "RAKAZO_COMPUTER_CPUS", apply: "NEW_COMPUTERS", services: [] },
  computerPidsLimit: { env: "RAKAZO_COMPUTER_PIDS_LIMIT", apply: "NEW_COMPUTERS", services: [] },
  sandboxIdleMs: { env: "SANDBOX_IDLE_MS", apply: "LIVE", services: [] },
  maxToolCallsPerTurn: { env: "MAX_TOOL_CALLS_PER_TURN", apply: "LIVE", services: [] },
  graphileWorkerConcurrency: {
    env: "GRAPHILE_WORKER_CONCURRENCY",
    apply: "RESTART",
    services: ["worker"],
  },
  logLevel: { env: "LOG_LEVEL", apply: "RESTART", services: ["api", "worker"] },
  axiomDataset: { env: "AXIOM_DATASET", apply: "RESTART", services: ["api", "worker"] },
  economicCalendarProvider: { env: "ECONOMIC_CALENDAR_PROVIDER", apply: "LIVE", services: [] },
};

/** Write-only credentials stored through SecretStore; their values are never returned. */
export const DeploymentSecretKeySchema = z.enum([
  "observability.axiomToken",
  "economicCalendar.apiKey",
]);
export type DeploymentSecretKey = z.infer<typeof DeploymentSecretKeySchema>;
export const DEPLOYMENT_SECRETS: Record<
  DeploymentSecretKey,
  { env: string; services: DeploymentService[] }
> = {
  "observability.axiomToken": { env: "AXIOM_TOKEN", services: ["api", "worker"] },
  "economicCalendar.apiKey": { env: "ECONOMIC_CALENDAR_API_KEY", services: [] },
};

/** Bootstrap identity: only presence is ever reported, never a value or a way to change it. */
export const BOOTSTRAP_SECRET_NAMES = [
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SANDBOX_SUPERVISOR_TOKEN",
  "SCREEN_PROXY_SECRET",
] as const;

export const DeploymentConfigUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  /** null reverts a setting to the deployment environment. */
  runtime: DeploymentRuntimeSettingsSchema.partial(),
});
export const PlaybookGroupIdSchema = z.enum([
  "entry-timing",
  "retest",
  "trendline",
  "candle",
  "targets",
  "execution",
  "news-protocol",
  "news-candle",
  "xauusd-behavior",
]);
export const PlaybookSettingsViewSchema = z.strictObject({
  version: z.string().min(1).max(32),
  revision: z.number().int().nonnegative(),
  groups: z
    .array(
      z.strictObject({
        id: PlaybookGroupIdSchema,
        label: z.string().min(1).max(80),
        enabled: z.boolean(),
        rules: z.number().int().nonnegative(),
      }),
    )
    .max(32),
});
export type PlaybookSettingsView = z.infer<typeof PlaybookSettingsViewSchema>;
export const PlaybookGroupUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  disabledGroups: z.array(PlaybookGroupIdSchema).max(32),
});
export const DeploymentSecretUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  key: DeploymentSecretKeySchema,
  /** null removes the stored credential. */
  value: z.string().trim().min(1).max(4096).nullable(),
});

const SettingValue = z.union([z.string(), z.number()]).nullable();
export const DeploymentConfigViewSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  updatedAt: Timestamp.nullable(),
  settings: z.array(
    z.strictObject({
      key: DeploymentRuntimeKeySchema,
      env: z.string(),
      value: SettingValue,
      effective: SettingValue,
      source: z.enum(["owner", "environment", "default"]),
      apply: z.enum(["LIVE", "RESTART", "NEW_COMPUTERS"]),
      restartRequired: z.array(z.enum(["api", "worker"])),
    }),
  ),
  secrets: z.array(
    z.strictObject({
      key: DeploymentSecretKeySchema,
      configured: z.boolean(),
      source: z.enum(["owner", "environment", "none"]),
      restartRequired: z.array(z.enum(["api", "worker"])),
    }),
  ),
  bootstrap: z.array(
    z.strictObject({
      name: z.enum(BOOTSTRAP_SECRET_NAMES),
      status: z.enum(["CONFIGURED", "MISSING", "PLACEHOLDER", "UNKNOWN"]),
    }),
  ),
  containment: z.strictObject({
    mode: z.enum(["open", "restricted", "financial"]).nullable(),
    verified: z.boolean(),
    observedAt: Timestamp.nullable(),
  }),
  services: z.array(
    z.strictObject({
      service: z.enum(["api", "worker"]),
      startedAt: Timestamp,
      heartbeatAt: Timestamp,
      revision: z.number().int().nonnegative(),
      gitSha: z.string().max(64).nullable(),
    }),
  ),
});
export type DeploymentConfigView = z.infer<typeof DeploymentConfigViewSchema>;
