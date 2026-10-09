import type { ChartIndicator, IndicatorCalculation } from "@rakazo/contracts";
import type { Chart, IndicatorFigure, KLineData } from "klinecharts";
import { registerIndicator } from "klinecharts";

/** Trusted library glue projects bounded backend series; no uploaded code runs in the browser. */
export function installChartIndicator(
  native: Pick<Chart, "createIndicator">,
  instance: ChartIndicator,
  result: IndicatorCalculation,
): { name: string; paneId: string } | null {
  const name = `rakazo_${instance.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const plotted = result.outputs.filter((out) => out.type !== "state");
  const figures: IndicatorFigure<Record<string, number>>[] = plotted.map((out) => ({
    key: out.id,
    title: out.id,
    type: out.type === "histogram" ? "bar" : out.type.startsWith("marker_") ? "circle" : "line",
  }));
  const project = indicatorSeries(result);
  registerIndicator<Record<string, number>>({
    name,
    shortName: instance.definitionId,
    figures,
    calc: project,
  });
  const paneId = native.createIndicator(
    { name, visible: instance.visible },
    true,
    instance.pane === "PRICE" ? { id: "candle_pane" } : undefined,
  );
  return paneId ? { name, paneId } : null;
}

export function indicatorSeries(result: IndicatorCalculation) {
  const values = new Map<number, Record<string, number>>();
  for (const output of result.outputs.filter((out) => out.type !== "state"))
    output.values.forEach((value, index) => {
      const timestamp = output.anchorTimes[index] ?? result.times[index];
      if (value === null || !timestamp) return;
      const time = Date.parse(timestamp);
      values.set(time, { ...values.get(time), [output.id]: value });
    });
  return (data: KLineData[]) => data.map((c) => values.get(c.timestamp) ?? {});
}
