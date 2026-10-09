// @vitest-environment jsdom
import { ChartIndicatorSchema, IndicatorCalculationSchema } from "@rakazo/contracts";
import { getSupportedIndicators } from "klinecharts";
import { expect, it, vi } from "vitest";
import { indicatorSeries, installChartIndicator } from "./kline-indicators";

const t1 = "2026-10-09T08:00:00Z",
  t2 = "2026-10-09T09:00:00Z";
const instance = ChartIndicatorSchema.parse({
  id: "fixture-indicator",
  definitionId: "fixture-definition",
  definitionVersion: 1,
  parameters: {},
  pane: "PRICE",
  visible: true,
  revision: 1,
  creator: "BOT",
  creatorId: "main",
  createdAt: t1,
  updatedAt: t1,
});
const result = IndicatorCalculationSchema.parse({
  definitionId: instance.definitionId,
  definitionVersion: 1,
  parameters: {},
  times: [t1, t2],
  outputs: [
    {
      id: "high",
      type: "marker_high",
      pane: "PRICE",
      values: [null, 2700],
      anchorTimes: [null, t1],
    },
  ],
});
it("projects confirmed markers at semantic anchors rather than confirmation time", () => {
  const projection = indicatorSeries(result);
  const rows = [
    { timestamp: Date.parse(t1), open: 2699, high: 2700, low: 2698, close: 2699 },
    { timestamp: Date.parse(t2), open: 2698, high: 2699, low: 2697, close: 2698 },
  ];
  expect(projection(rows)).toEqual([{ high: 2700 }, {}]);
  expect(result.outputs[0]?.values).toEqual([null, 2700]);
});
it("registers a safe trusted callback and uses the deployed pane API", () => {
  const createIndicator = vi.fn(() => "candle_pane");
  const installed = installChartIndicator({ createIndicator }, instance, result);
  expect(installed).toEqual({ name: "rakazo_fixture_indicator", paneId: "candle_pane" });
  expect(getSupportedIndicators()).toContain(installed?.name);
  expect(createIndicator).toHaveBeenCalledWith(
    { name: "rakazo_fixture_indicator", visible: true },
    true,
    { id: "candle_pane" },
  );
});
it("supports a separate pane without changing the stored calculation meaning", () => {
  const createIndicator = vi.fn(() => "separate");
  installChartIndicator({ createIndicator }, { ...instance, pane: "SEPARATE" }, result);
  expect(createIndicator).toHaveBeenCalledWith(expect.anything(), true, undefined);
  expect(instance.pane).toBe("PRICE");
});
