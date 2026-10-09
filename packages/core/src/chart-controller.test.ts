import type { ChartCommand, CloudChartState } from "@rakazo/contracts";
import { CloudChartStateSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { CHART_DRAWING_CAPABILITIES, changeChartState } from "./chart-controller.js";

const now = new Date("2026-10-09T12:00:00Z");
const initial: CloudChartState = {
  version: 1,
  timeframe: "1h",
  viewport: { from: null, to: null, candleCount: 200, rightSpacing: 40 },
  drawings: [],
  indicators: [],
  preferences: { theme: "dark", timezone: "UTC" },
};
function apply(command: ChartCommand, state = initial, user = false) {
  return changeChartState({
    command,
    state,
    revision: 1,
    instrumentId: "gold",
    actor: { id: user ? "owner" : "main", user },
    now,
    newId: "drawing",
  });
}
describe("semantic chart controller", () => {
  it("restores timeframe, candle count, exact history and navigation as serializable state", () => {
    let state = apply({
      operation: "set_timeframe",
      chartId: "chart",
      expectedRevision: 1,
      timeframe: "4h",
    });
    state = apply({ operation: "zoom", chartId: "chart", expectedRevision: 1, factor: 2 }, state);
    expect(state.viewport.candleCount).toBe(100);
    state = apply(
      { operation: "jump", chartId: "chart", expectedRevision: 1, time: "2026-10-01T00:00:00Z" },
      state,
    );
    expect(state.viewport.to).toBe("2026-10-01T04:00:00.000Z");
    state = apply({ operation: "pan", chartId: "chart", expectedRevision: 1, candles: -2 }, state);
    expect(state.viewport.to).toBe("2026-09-30T20:00:00.000Z");
    expect(CloudChartStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(
      apply({ operation: "reset_view", chartId: "chart", expectedRevision: 1 }, state).viewport
        .from,
    ).toBeNull();
  });
  it("rejects stale viewport writes", () => {
    expect(() =>
      apply({ operation: "zoom", chartId: "chart", expectedRevision: 2, factor: 2 }),
    ).toThrow("Chart changed");
  });
  it.each(CHART_DRAWING_CAPABILITIES)(
    "validates %s semantic anchors and preserves exact prices",
    (type, anchors) => {
      const drawing = {
        type,
        points: Array.from({ length: anchors }, (_, i) => ({
          time: new Date(now.getTime() + i * 60000).toISOString(),
          price: "2674.123456789123",
        })),
        text: "",
        visible: true,
        locked: false,
        evidenceRefs: [],
      };
      const state = apply({
        operation: "drawing_create",
        chartId: "chart",
        expectedRevision: 1,
        drawing,
      });
      expect(state.drawings[0]?.points[0]?.price).toBe("2674.123456789123");
      expect(state.drawings[0]?.instrumentId).toBe("gold");
      expect(() =>
        apply({
          operation: "drawing_create",
          chartId: "chart",
          expectedRevision: 1,
          drawing: { ...drawing, points: [...drawing.points, ...drawing.points] },
        }),
      ).toThrow("anchor count");
      const changed = apply(
        {
          operation: "drawing_update",
          chartId: "chart",
          drawingId: "drawing",
          expectedDrawingRevision: 1,
          drawing: { ...drawing, visible: false },
        },
        state,
      );
      expect(changed.drawings[0]?.revision).toBe(2);
      expect(() =>
        apply(
          {
            operation: "drawing_delete",
            chartId: "chart",
            drawingId: "drawing",
            expectedDrawingRevision: 1,
          },
          changed,
        ),
      ).toThrow("Chart changed");
      expect(
        apply(
          {
            operation: "drawing_delete",
            chartId: "chart",
            drawingId: "drawing",
            expectedDrawingRevision: 2,
          },
          changed,
        ).drawings,
      ).toEqual([]);
    },
  );
  it("never lets a bot edit user drawings or erase them by changing instruments", () => {
    const state = apply(
      {
        operation: "drawing_create",
        chartId: "chart",
        expectedRevision: 1,
        drawing: {
          type: "horizontalStraightLine",
          points: [{ time: now.toISOString(), price: "2700" }],
          text: "User",
          visible: true,
          locked: false,
          evidenceRefs: [],
        },
      },
      initial,
      true,
    );
    expect(state.drawings[0]?.creator).toBe("USER");
    expect(() =>
      apply(
        {
          operation: "drawing_delete",
          chartId: "chart",
          drawingId: "drawing",
          expectedDrawingRevision: 1,
        },
        state,
      ),
    ).toThrow("not editable");
    expect(
      apply(
        {
          operation: "set_instrument",
          chartId: "chart",
          expectedRevision: 1,
          accountId: "another",
          instrumentId: "eur",
        },
        state,
      ).drawings,
    ).toEqual(state.drawings);
  });
});
