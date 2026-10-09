import { z } from "zod";
import { CloudChartSchema } from "./cloud-chart.js";
import { BrokerCandleSchema } from "./trading.js";

const Id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/);
const Ref = z.string().min(1).max(128);
const Numeric = z.number().finite().min(-1e18).max(1e18);
const Window = z.union([z.number().int().min(1).max(512), z.strictObject({ parameter: Id })]);
export const IndicatorParameterSchema = z
  .strictObject({
    name: Id,
    default: Numeric,
    min: Numeric,
    max: Numeric,
    integer: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.min > p.default || p.max < p.default || (p.integer && !Number.isInteger(p.default)))
      ctx.addIssue({ code: "custom", message: "Invalid parameter bounds" });
  });
export const IndicatorNodeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    id: Id,
    op: z.literal("input"),
    field: z.enum(["open", "high", "low", "close", "volume"]),
  }),
  z.strictObject({ id: Id, op: z.literal("constant"), value: Numeric }),
  z.strictObject({ id: Id, op: z.literal("parameter"), parameter: Id }),
  z.strictObject({
    id: Id,
    op: z.enum([
      "add",
      "subtract",
      "multiply",
      "divide",
      "min",
      "max",
      "gt",
      "gte",
      "lt",
      "lte",
      "equal",
      "and",
      "or",
      "cross_above",
      "cross_below",
    ]),
    a: Id,
    b: Id,
  }),
  z.strictObject({ id: Id, op: z.literal("if"), condition: Id, whenTrue: Id, whenFalse: Id }),
  z.strictObject({ id: Id, op: z.literal("shift"), input: Id, bars: Window }),
  z.strictObject({
    id: Id,
    op: z.enum(["rolling_min", "rolling_max", "rolling_mean", "rolling_sum", "rolling_std"]),
    input: Id,
    window: Window,
  }),
  z.strictObject({
    id: Id,
    op: z.enum(["swing_high", "swing_low"]),
    input: Id,
    left: Window,
    right: Window,
    minimumMove: Numeric.default(0),
  }),
]);
export const IndicatorDefinitionSchema = z.strictObject({
  definitionVersion: z.literal(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000),
  parameters: z.array(IndicatorParameterSchema).max(16),
  nodes: z.array(IndicatorNodeSchema).min(1).max(64),
  outputs: z
    .array(
      z.strictObject({
        id: Id,
        node: Id,
        label: z.string().max(80),
        type: z.enum([
          "line",
          "histogram",
          "marker_high",
          "marker_low",
          "band_upper",
          "band_lower",
          "state",
        ]),
        pane: z.enum(["PRICE", "SEPARATE"]),
      }),
    )
    .min(1)
    .max(8),
});
export type IndicatorDefinition = z.infer<typeof IndicatorDefinitionSchema>;
export type IndicatorNode = z.infer<typeof IndicatorNodeSchema>;
export const CustomIndicatorSchema = z.strictObject({
  id: Ref,
  ownerUserId: Ref,
  version: z.number().int().positive(),
  source: z.enum(["BUILTIN", "BOT", "USER", "USER_IMPORTED"]),
  definition: IndicatorDefinitionSchema,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: Ref,
  createdAt: z.iso.datetime({ offset: true }),
  originalFilename: z.string().max(128).nullable(),
  validationStatus: z.literal("VALIDATED"),
  testStatus: z.literal("PASSED"),
  securityStatus: z.literal("SAFE_IR"),
});
export type CustomIndicator = z.infer<typeof CustomIndicatorSchema>;
export const IndicatorCalculationSchema = z.strictObject({
  instanceId: Ref.optional(),
  definitionId: Ref,
  definitionVersion: z.number().int().positive(),
  parameters: z.record(Id, Numeric),
  times: z.array(z.iso.datetime({ offset: true })).max(2000),
  outputs: z
    .array(
      z.strictObject({
        id: Id,
        type: z.string().max(32),
        pane: z.enum(["PRICE", "SEPARATE"]),
        values: z.array(Numeric.nullable()).max(2000),
        anchorTimes: z.array(z.iso.datetime({ offset: true }).nullable()).max(2000),
      }),
    )
    .max(8),
});
export type IndicatorCalculation = z.infer<typeof IndicatorCalculationSchema>;
export const IndicatorRegistryCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("search"), query: z.string().max(128).default("") }),
  z.strictObject({ operation: z.literal("get"), id: Ref, version: z.number().int().positive() }),
  z.strictObject({
    operation: z.literal("create"),
    definition: IndicatorDefinitionSchema,
    previousId: Ref.optional(),
    expectedVersion: z.number().int().positive().optional(),
  }),
  z.strictObject({ operation: z.literal("import"), artifactId: Ref }),
  z.strictObject({
    operation: z.literal("calculate"),
    id: Ref,
    version: z.number().int().positive(),
    chartId: Ref,
    parameters: z
      .record(Id, Numeric)
      .refine((v) => Object.keys(v).length <= 16)
      .default({}),
  }),
]);
export type IndicatorRegistryCommand = z.infer<typeof IndicatorRegistryCommandSchema>;
export const IndicatorRegistryResponseSchema = z.union([
  CustomIndicatorSchema,
  z.array(CustomIndicatorSchema).max(100),
  IndicatorCalculationSchema,
]);
export type IndicatorRegistryResponse = z.infer<typeof IndicatorRegistryResponseSchema>;

export const ChartEvidenceSchema = z.strictObject({
  chart: CloudChartSchema,
  candles: z.array(BrokerCandleSchema).max(1000),
  calculations: z.array(IndicatorCalculationSchema).max(32),
});
export type ChartEvidence = z.infer<typeof ChartEvidenceSchema>;
