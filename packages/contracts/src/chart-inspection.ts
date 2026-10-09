import { z } from "zod";

const Target = { chartId: z.string().min(1).max(128) };
/** No URLs, filesystem paths, HTML or renderer code enter this boundary. */
export const ChartInspectionCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("evidence"), ...Target }),
  z.strictObject({
    operation: z.literal("candle"),
    ...Target,
    timestamp: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    operation: z.literal("render"),
    ...Target,
    attach: z.boolean().default(false),
  }),
]);
export type ChartInspectionCommand = z.infer<typeof ChartInspectionCommandSchema>;

export const ChartRenderMetadataSchema = z.strictObject({
  renderer: z.literal("chart-svg-v1"),
  chartId: z.string(),
  chartRevision: z.number().int().positive(),
  instrumentId: z.string(),
  brokerSymbol: z.string(),
  timeframe: z.string(),
  visibleCandleCount: z.number().int().min(0).max(1000),
  visibleFrom: z.iso.datetime({ offset: true }).nullable(),
  visibleTo: z.iso.datetime({ offset: true }).nullable(),
  lastPrice: z.string().nullable(),
  lastCompletedCandle: z.iso.datetime({ offset: true }).nullable(),
  provider: z.string().nullable(),
  fetchedAt: z.iso.datetime({ offset: true }).nullable(),
  drawingIds: z.array(z.string()).max(256),
  indicators: z
    .array(
      z.strictObject({
        id: z.string(),
        definitionId: z.string(),
        version: z.number().int().positive(),
        parameters: z.record(z.string(), z.number().finite()),
      }),
    )
    .max(32),
  width: z.literal(960),
  height: z.number().int().min(420).max(3492),
});
export const ChartRenderResponseSchema = z.strictObject({
  mimeType: z.literal("image/png"),
  data: z.string().min(1).max(10_000_000),
  metadata: ChartRenderMetadataSchema,
});
export type ChartRenderResponse = z.infer<typeof ChartRenderResponseSchema>;
