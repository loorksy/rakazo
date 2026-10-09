import { createHash } from "node:crypto";
import type { BrokerCandle, CustomIndicator, IndicatorDefinition } from "@rakazo/contracts";
import { CustomIndicatorSchema } from "@rakazo/contracts";
import { calculateIndicator, IndicatorValidationError, validateIndicator } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
export const builtins: Record<string, IndicatorDefinition> = {
  "builtin:SMA": {
    definitionVersion: 1,
    name: "Simple moving average",
    description: "Arithmetic mean over a configurable rolling window.",
    parameters: [{ name: "period", default: 14, min: 1, max: 512, integer: true }],
    nodes: [
      { id: "close", op: "input", field: "close" },
      { id: "average", op: "rolling_mean", input: "close", window: { parameter: "period" } },
    ],
    outputs: [{ id: "average", node: "average", label: "SMA", type: "line", pane: "PRICE" }],
  },
  "builtin:STD": {
    definitionVersion: 1,
    name: "Rolling standard deviation",
    description: "Population standard deviation of closing values.",
    parameters: [{ name: "period", default: 20, min: 1, max: 512, integer: true }],
    nodes: [
      { id: "close", op: "input", field: "close" },
      { id: "deviation", op: "rolling_std", input: "close", window: { parameter: "period" } },
    ],
    outputs: [
      { id: "deviation", node: "deviation", label: "Deviation", type: "line", pane: "SEPARATE" },
    ],
  },
  "builtin:VOL": {
    definitionVersion: 1,
    name: "Broker volume",
    description: "Provider-reported volume; missing volume remains unavailable.",
    parameters: [],
    nodes: [{ id: "volume", op: "input", field: "volume" }],
    outputs: [
      { id: "volume", node: "volume", label: "Volume", type: "histogram", pane: "SEPARATE" },
    ],
  },
};
function hash(definition: IndicatorDefinition) {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}
function fixture(): BrokerCandle[] {
  return Array.from({ length: 80 }, (_, i) => {
    const mid = 100 + Math.sin(i / 3) * 4 + i / 10;
    return {
      version: 1,
      provider: "validation-fixture",
      accountId: "fixture-account",
      instrumentId: "fixture-instrument",
      brokerSymbol: "FIXTURE",
      timeframe: "1h",
      openTime: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      open: mid.toFixed(6),
      high: (mid + 1).toFixed(6),
      low: (mid - 1).toFixed(6),
      close: mid.toFixed(6),
      volume: i % 7 === 0 ? null : String(i + 1),
      complete: true,
      fetchedAt: "2026-01-05T00:00:00Z",
      revision: String(i),
    };
  });
}
/** Activation validates representation, reproducibility and boundary cases, not profitability. */
export function testIndicatorDefinition(raw: unknown) {
  const definition = validateIndicator(raw);
  const data = fixture();
  const first = calculateIndicator(definition, data);
  if (JSON.stringify(first) !== JSON.stringify(calculateIndicator(definition, data)))
    throw new IndicatorValidationError("Indicator is not reproducible");
  calculateIndicator(definition, []);
  calculateIndicator(definition, data.slice(0, 2));
  calculateIndicator(
    definition,
    data.map((c) => ({ ...c, timeframe: "4h" })),
  );
  const extremes = Object.fromEntries(definition.parameters.map((p) => [p.name, p.max]));
  calculateIndicator(
    definition,
    fixture().concat(
      Array.from({ length: 1920 }, (_, i) =>
        (() => {
          const sample = data[i % 80];
          if (!sample) throw new IndicatorValidationError();
          return { ...sample, openTime: new Date(Date.UTC(2026, 0, 1, i + 80)).toISOString() };
        })(),
      ),
    ),
    extremes,
  );
  return definition;
}

export async function loadChartIndicator(
  prisma: PrismaClient,
  ownerUserId: string,
  id: string,
  version: number,
): Promise<CustomIndicator> {
  const builtin = Object.hasOwn(builtins, id) ? builtins[id] : undefined;
  if (builtin) {
    if (version !== 1) throw new IndicatorValidationError("Indicator version unavailable");
    return CustomIndicatorSchema.parse({
      id,
      ownerUserId: ownerUserId,
      version,
      source: "BUILTIN",
      definition: builtin,
      definitionHash: hash(builtin),
      createdBy: "builtin",
      createdAt: "2026-01-01T00:00:00Z",
      originalFilename: null,
      validationStatus: "VALIDATED",
      testStatus: "PASSED",
      securityStatus: "SAFE_IR",
    });
  }
  const row = await prisma.chartIndicatorDefinition.findFirst({
    where: { id, version, ownerUserId: ownerUserId },
  });
  if (!row) throw new IndicatorValidationError("Indicator version unavailable");
  const { name: _name, ...view } = row;
  return CustomIndicatorSchema.parse({
    ...view,
    createdAt: row.createdAt.toISOString(),
    validationStatus: "VALIDATED",
    testStatus: "PASSED",
    securityStatus: "SAFE_IR",
  });
}
