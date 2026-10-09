import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type {
  CustomIndicator,
  IndicatorDefinition,
  IndicatorRegistryResponse,
} from "@rakazo/contracts";
import {
  BrokerCandleSchema,
  IndicatorRegistryCommandSchema,
  IndicatorRegistryResponseSchema,
} from "@rakazo/contracts";
import { calculateIndicator, IndicatorValidationError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  builtins,
  loadChartIndicator,
  testIndicatorDefinition,
} from "./chart-indicator-definitions.js";
import type { ChartActor } from "./cloud-charts.js";
import { CloudCharts, fenceChartExecution } from "./cloud-charts.js";
import { requestBrokerRead } from "./trading-connections.js";

/** One owner registry with immutable versions. No source evaluation or runtime IO in the IR. */
export class ChartIndicators {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly artifacts?: ArtifactStore,
  ) {}
  async command(actor: ChartActor, raw: unknown): Promise<IndicatorRegistryResponse> {
    const charts = new CloudCharts(this.prisma);
    await charts.command(actor, { operation: "capabilities" });
    const cmd = IndicatorRegistryCommandSchema.parse(raw);
    if (cmd.operation === "get")
      return loadChartIndicator(this.prisma, actor.ownerUserId, cmd.id, cmd.version);
    if (cmd.operation === "search") {
      const records = await this.prisma.chartIndicatorDefinition.findMany({
        where: {
          ownerUserId: actor.ownerUserId,
          ...(cmd.query ? { name: { contains: cmd.query, mode: "insensitive" } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { version: "desc" }],
        take: 100,
      });
      const seen = new Set<string>();
      const custom: CustomIndicator[] = [];
      for (const row of records) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        custom.push(await loadChartIndicator(this.prisma, actor.ownerUserId, row.id, row.version));
      }
      const defaults = await Promise.all(
        Object.keys(builtins)
          .filter((id) => builtins[id]?.name.toLowerCase().includes(cmd.query.toLowerCase()))
          .map((id) => loadChartIndicator(this.prisma, actor.ownerUserId, id, 1)),
      );
      return IndicatorRegistryResponseSchema.parse([...defaults, ...custom].slice(0, 100));
    }
    if (cmd.operation === "calculate") {
      const record = await loadChartIndicator(this.prisma, actor.ownerUserId, cmd.id, cmd.version);
      const chart = await charts.command(actor, { operation: "get", chartId: cmd.chartId });
      if (!("state" in chart)) throw new IndicatorValidationError();
      const raw = await requestBrokerRead(this.prisma, actor.ownerUserId, {
        operation: "candles",
        accountId: chart.accountId,
        instrumentId: chart.instrumentId,
        timeframe: chart.state.timeframe,
        limit: chart.state.viewport.candleCount,
        ...(chart.state.viewport.to ? { before: chart.state.viewport.to } : {}),
      });
      const candles = BrokerCandleSchema.array().max(1000).parse(raw);
      if (
        candles.some(
          (c) =>
            c.accountId !== chart.accountId ||
            c.instrumentId !== chart.instrumentId ||
            c.timeframe !== chart.state.timeframe,
        )
      )
        throw new IndicatorValidationError("Indicator evidence identity mismatch");
      return IndicatorRegistryResponseSchema.parse({
        definitionId: record.id,
        definitionVersion: record.version,
        ...calculateIndicator(record.definition, candles, cmd.parameters),
      });
    }
    let definition: IndicatorDefinition;
    let originalFilename: string | null = null;
    if (cmd.operation === "import") {
      if (!this.artifacts)
        throw new IndicatorValidationError("Indicator upload storage unavailable");
      const settings = await this.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      const artifact = await this.prisma.artifact.findFirst({
        where: {
          id: cmd.artifactId,
          userId: actor.ownerUserId,
          spaceId: settings?.ownerSpaceId ?? "",
          ...(actor.botId ? { botId: actor.botId } : {}),
        },
      });
      if (
        !artifact ||
        artifact.size > 65536 ||
        !artifact.name.toLowerCase().endsWith(".json") ||
        !["application/json", "text/plain"].includes(artifact.mimeType)
      )
        throw new IndicatorValidationError(
          "Upload a safe indicator JSON definition (maximum 64 KiB)",
        );
      const bytes = await this.artifacts.get(artifact.storageKey, {
        userId: actor.ownerUserId,
        spaceId: artifact.spaceId,
        botId: actor.botId,
        operationId: `indicator:${cmd.artifactId}`,
        traceId: `indicator:${cmd.artifactId}`,
        signal: new AbortController().signal,
      });
      if (bytes.byteLength > 65536)
        throw new IndicatorValidationError("Indicator upload size exceeded");
      definition = testIndicatorDefinition(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      originalFilename = artifact.name;
    } else definition = testIndicatorDefinition(cmd.definition);
    const fingerprint = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
    const result = await this.prisma.$transaction(async (tx) => {
      await fenceChartExecution(tx, actor);
      await tx.$queryRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;

      if (
        (await tx.chartIndicatorDefinition.count({ where: { ownerUserId: actor.ownerUserId } })) >=
        1000
      )
        throw new IndicatorValidationError("Indicator registry limit reached");
      let id: string = randomUUID();
      let version = 1;
      if (cmd.operation === "create" && cmd.previousId) {
        const previous = await tx.chartIndicatorDefinition.findFirst({
          where: { id: cmd.previousId, ownerUserId: actor.ownerUserId },
          orderBy: { version: "desc" },
        });
        if (!previous || previous.version !== cmd.expectedVersion)
          throw new IndicatorValidationError("Indicator version conflict");
        id = previous.id;
        version = previous.version + 1;
        if (version > 100) throw new IndicatorValidationError("Indicator version limit reached");
      } else if (cmd.operation === "create" && cmd.expectedVersion)
        throw new IndicatorValidationError("Previous indicator identity required");
      const same = await tx.chartIndicatorDefinition.findFirst({
        where: {
          ownerUserId: actor.ownerUserId,
          definitionHash: fingerprint,
          ...(cmd.operation === "create" && cmd.previousId ? { id: cmd.previousId } : {}),
        },
        orderBy: { version: "desc" },
      });
      if (same) return { id: same.id, version: same.version };
      await tx.chartIndicatorDefinition.create({
        data: {
          id,
          version,
          ownerUserId: actor.ownerUserId,
          name: definition.name,
          definition,
          definitionHash: fingerprint,
          source: cmd.operation === "import" ? "USER_IMPORTED" : actor.botId ? "BOT" : "USER",
          createdBy: actor.botId ?? actor.ownerUserId,
          originalFilename,
        },
      });
      return { id, version };
    });
    return loadChartIndicator(this.prisma, actor.ownerUserId, result.id, result.version);
  }
}
