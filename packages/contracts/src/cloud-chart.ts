import { z } from "zod";
import { PositiveTradingDecimalSchema } from "./trading.js";

const Ref = z.string().min(1).max(128);
const Time = z.iso.datetime({ offset: true });
export const BrokerTimeframeSchema = z.enum([
  "1m",
  "2m",
  "3m",
  "4m",
  "5m",
  "6m",
  "10m",
  "12m",
  "15m",
  "20m",
  "30m",
  "1h",
  "2h",
  "3h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "1w",
  "1mn",
]);
export const ChartPointSchema = z.strictObject({ time: Time, price: PositiveTradingDecimalSchema });
export const ChartViewportSchema = z
  .strictObject({
    from: Time.nullable(),
    to: Time.nullable(),
    candleCount: z.number().int().min(10).max(1000),
    rightSpacing: z.number().int().min(0).max(200),
  })
  .superRefine((value, ctx) => {
    if (
      (value.from === null) !== (value.to === null) ||
      (value.from && value.to && Date.parse(value.from) >= Date.parse(value.to))
    )
      ctx.addIssue({ code: "custom", message: "Provide an ordered range or omit both endpoints" });
  });

/** Stable adapter IDs, not executable library configuration. */
export const ChartDrawingTypeSchema = z.enum([
  "horizontalStraightLine",
  "verticalStraightLine",
  "segment",
  "rayLine",
  "straightLine",
  "priceLine",
  "priceChannelLine",
  "parallelStraightLine",
  "rect",
  "triangle",
  "fibonacciLine",
  "fibonacciSegment",
  "simpleAnnotation",
  "simpleTag",
]);
export const ChartDrawingInputSchema = z.strictObject({
  type: ChartDrawingTypeSchema,
  points: z.array(ChartPointSchema).min(1).max(4),
  text: z.string().max(256).default(""),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  evidenceRefs: z.array(Ref).max(16).default([]),
});
export const ChartDrawingSchema = ChartDrawingInputSchema.extend({
  id: Ref,
  instrumentId: Ref,
  revision: z.number().int().positive(),
  creator: z.enum(["USER", "BOT", "IMPORT"]),
  creatorId: Ref,
  responsibilityId: Ref.nullable(),
  createdAt: Time,
  updatedAt: Time,
});
export const ChartIndicatorInputSchema = z.strictObject({
  definitionId: Ref,
  definitionVersion: z.number().int().positive(),
  parameters: z
    .record(z.string().max(64), z.number().finite())
    .refine((v) => Object.keys(v).length <= 16),
  pane: z.enum(["PRICE", "SEPARATE"]),
  visible: z.boolean(),
});
export const ChartIndicatorSchema = ChartIndicatorInputSchema.extend({
  id: Ref,
  revision: z.number().int().positive(),
  creator: z.enum(["USER", "BOT"]),
  creatorId: Ref,
  createdAt: Time,
  updatedAt: Time,
});
export type ChartIndicator = z.infer<typeof ChartIndicatorSchema>;
export const CloudChartStateSchema = z.strictObject({
  version: z.literal(1),
  timeframe: BrokerTimeframeSchema,
  viewport: ChartViewportSchema,
  drawings: z.array(ChartDrawingSchema).max(256),
  indicators: z.array(ChartIndicatorSchema).max(32),
  preferences: z.strictObject({ theme: z.enum(["light", "dark"]), timezone: z.literal("UTC") }),
});
export const CloudChartSchema = z.strictObject({
  id: Ref,
  ownerUserId: Ref,
  ownerBotId: Ref.nullable(),
  scope: z.enum(["MAIN", "SHARED", "WORKER"]),
  accountId: Ref,
  instrumentId: Ref,
  brokerSymbol: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  state: CloudChartStateSchema,
  createdAt: Time,
  updatedAt: Time,
});
export type CloudChart = z.infer<typeof CloudChartSchema>;
export type CloudChartState = z.infer<typeof CloudChartStateSchema>;
export type ChartDrawing = z.infer<typeof ChartDrawingSchema>;
export type ChartPoint = z.infer<typeof ChartPointSchema>;

const target = { chartId: Ref, expectedRevision: z.number().int().positive() };
export const ChartCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("capabilities") }),
  z.strictObject({ operation: z.literal("list") }),
  z.strictObject({
    operation: z.literal("create"),
    accountId: Ref,
    instrumentId: Ref,
    timeframe: BrokerTimeframeSchema,
    scope: z.enum(["MAIN", "SHARED", "WORKER"]).default("MAIN"),
  }),
  z.strictObject({ operation: z.literal("get"), chartId: Ref }),
  z.strictObject({
    operation: z.literal("set_instrument"),
    ...target,
    accountId: Ref,
    instrumentId: Ref,
  }),
  z.strictObject({
    operation: z.literal("set_timeframe"),
    ...target,
    timeframe: BrokerTimeframeSchema,
  }),
  z.strictObject({
    operation: z.literal("set_viewport"),
    ...target,
    viewport: ChartViewportSchema,
  }),
  z.strictObject({ operation: z.literal("zoom"), ...target, factor: z.number().min(0.25).max(4) }),
  z.strictObject({
    operation: z.literal("pan"),
    ...target,
    candles: z.number().int().min(-1000).max(1000),
  }),
  z.strictObject({ operation: z.literal("jump"), ...target, time: Time }),
  z.strictObject({ operation: z.literal("reset_view"), ...target }),
  z.strictObject({
    operation: z.literal("indicator_add"),
    ...target,
    indicator: ChartIndicatorInputSchema,
  }),
  z.strictObject({
    operation: z.literal("indicator_update"),
    chartId: Ref,
    indicatorId: Ref,
    expectedIndicatorRevision: z.number().int().positive(),
    indicator: ChartIndicatorInputSchema,
  }),
  z.strictObject({
    operation: z.literal("indicator_remove"),
    chartId: Ref,
    indicatorId: Ref,
    expectedIndicatorRevision: z.number().int().positive(),
  }),
  z.strictObject({
    operation: z.literal("drawing_create"),
    ...target,
    drawing: ChartDrawingInputSchema,
  }),
  z.strictObject({
    operation: z.literal("drawing_update"),
    chartId: Ref,
    drawingId: Ref,
    expectedDrawingRevision: z.number().int().positive(),
    drawing: ChartDrawingInputSchema,
  }),
  z.strictObject({
    operation: z.literal("drawing_delete"),
    chartId: Ref,
    drawingId: Ref,
    expectedDrawingRevision: z.number().int().positive(),
  }),
]);
export type ChartCommand = z.infer<typeof ChartCommandSchema>;

export const ChartCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  library: z.string().max(128),
  drawingTools: z
    .array(
      z.strictObject({
        id: ChartDrawingTypeSchema,
        anchors: z.number().int().positive(),
        editable: z.literal(true),
        semantic: z.literal(true),
      }),
    )
    .max(128),
  operations: z.array(z.string().max(64)).max(64),
});
export const ChartResponseSchema = z.union([
  CloudChartSchema,
  z.array(CloudChartSchema).max(100),
  ChartCapabilitiesSchema,
]);
export type ChartResponse = z.infer<typeof ChartResponseSchema>;

export const ChartEventSchema = z.strictObject({
  chartId: Ref,
  revision: z.number().int().positive(),
  actor: z.enum(["BOT", "USER"]),
  operation: z.string().max(64),
  at: Time,
  points: z.array(ChartPointSchema).max(4),
});
export type ChartEvent = z.infer<typeof ChartEventSchema>;
