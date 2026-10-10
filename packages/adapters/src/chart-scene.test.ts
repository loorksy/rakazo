import type { ChartEvidence } from "@rakazo/contracts";
import { ChartEvidenceSchema } from "@rakazo/contracts";
import { CHART_DRAWING_CAPABILITIES } from "@rakazo/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  chartScene,
  chartVisionResult,
  renderChartView,
  visibleChartCandles,
} from "./chart-scene.js";

function fixture(): ChartEvidence {
  const start = Date.parse("2026-10-09T00:00:00Z");
  const time = (i: number) => new Date(start + i * 3600000).toISOString();
  return ChartEvidenceSchema.parse({
    chart: {
      id: "chart",
      ownerUserId: "owner",
      ownerBotId: "main",
      scope: "PRIVATE",
      accountId: "account",
      instrumentId: "gold",
      brokerSymbol: "XAUUSDm",
      revision: 1,
      createdAt: time(0),
      updatedAt: time(0),
      state: {
        version: 1,
        timeframe: "1h",
        viewport: { from: null, to: null, candleCount: 10, rightSpacing: 40 },
        drawings: [],
        indicators: [],
        preferences: { theme: "dark", timezone: "UTC" },
      },
    },
    candles: Array.from({ length: 20 }, (_, i) => ({
      version: 1,
      provider: "metaapi",
      accountId: "account",
      instrumentId: "gold",
      brokerSymbol: "XAUUSDm",
      timeframe: "1h",
      openTime: time(i),
      open: "2674.123456789123",
      high: "2676",
      low: "2673",
      close: "2675",
      volume: "100",
      complete: i < 19,
      fetchedAt: time(20),
      revision: `c${i}`,
    })),
    calculations: [],
  });
}

describe("chart-only visual scene", () => {
  it("forwards chart PNG through the existing model image interface with exact non-vision fallback", async () => {
    const evidence = fixture();
    const rendered = await renderChartView(evidence);
    const vision = chartVisionResult(evidence, rendered, true, "image-artifact");
    expect(vision.content[1]).toEqual({
      type: "image",
      data: rendered.png.toString("base64"),
      mimeType: "image/png",
    });
    expect(
      JSON.parse(vision.content[0]?.type === "text" ? vision.content[0].text : "{}"),
    ).toMatchObject({ artifactId: "image-artifact", visionAvailable: true });
    const fallback = chartVisionResult(evidence, rendered, false);
    expect(fallback.content).toHaveLength(1);
    expect(fallback.content[0]?.type).toBe("text");
    expect(
      JSON.parse(fallback.content[0]?.type === "text" ? fallback.content[0].text : "{}").candles[0]
        .open,
    ).toBe("2674.123456789123");
    expect(JSON.stringify(fallback.details)).not.toContain(rendered.png.toString("base64"));
  });
  it("renders a deterministic PNG with precise broker evidence and bounded dimensions", async () => {
    const evidence = fixture();
    const first = await renderChartView(evidence);
    const second = await renderChartView(evidence);
    expect(first.png).toEqual(second.png);
    expect(first.metadata).toMatchObject({
      renderer: "chart-svg-v1",
      brokerSymbol: "XAUUSDm",
      timeframe: "1h",
      visibleCandleCount: 10,
      lastPrice: "2675",
      lastCompletedCandle: evidence.candles[18]?.openTime,
    });
    expect(await sharp(first.png).metadata()).toMatchObject({
      format: "png",
      width: 960,
      height: 420,
    });
    expect(first.png.byteLength).toBeLessThan(1_000_000);
  });
  it("uses saved historical range and preserves exact numeric candle inspection", () => {
    const evidence = fixture();
    evidence.chart.state.viewport.from = evidence.candles[4]?.openTime ?? null;
    evidence.chart.state.viewport.to = evidence.candles[12]?.openTime ?? null;
    expect(visibleChartCandles(evidence)).toHaveLength(9);
    expect(visibleChartCandles(evidence)[0]?.open).toBe("2674.123456789123");
    expect(chartScene(evidence).metadata.visibleTo).toBe(evidence.candles[12]?.openTime);
  });
  it.each(CHART_DRAWING_CAPABILITIES)(
    "renders deployed %s semantic anchors without browser access",
    async (type, anchors) => {
      const evidence = fixture();
      evidence.chart.state.drawings.push({
        id: "drawing",
        instrumentId: "gold",
        revision: 1,
        creator: "BOT",
        creatorId: "main",
        responsibilityId: null,
        createdAt: evidence.chart.createdAt,
        updatedAt: evidence.chart.updatedAt,
        type,
        points: Array.from({ length: anchors }, (_, i) => ({
          time: evidence.candles[11 + i * 2]?.openTime ?? evidence.chart.createdAt,
          price: String(2674 + i * 0.5),
        })),
        text: "منطقة دعم",
        visible: true,
        locked: false,
        evidenceRefs: [],
      });
      const scene = chartScene(evidence);
      expect(scene.metadata.drawingIds).toEqual(["drawing"]);
      expect(scene.svg).toContain("منطقة دعم");
      expect((await renderChartView(evidence)).png).not.toEqual(
        (await renderChartView(fixture())).png,
      );
    },
  );
  it("renders exact indicator versions and parameters on price and separate panes", async () => {
    const evidence = fixture();
    const instance = {
      id: "volume",
      revision: 1,
      creator: "BOT" as const,
      creatorId: "main",
      createdAt: evidence.chart.createdAt,
      updatedAt: evidence.chart.updatedAt,
      definitionId: "builtin:VOL",
      definitionVersion: 1,
      parameters: {},
      pane: "SEPARATE" as const,
      visible: true,
    };
    evidence.chart.state.indicators.push(instance);
    evidence.calculations.push({
      instanceId: "volume",
      definitionId: "builtin:VOL",
      definitionVersion: 1,
      parameters: {},
      times: evidence.candles.map((c) => c.openTime),
      outputs: [
        {
          id: "volume",
          type: "histogram",
          pane: "SEPARATE",
          values: evidence.candles.map(() => 100),
          anchorTimes: evidence.candles.map(() => null),
        },
      ],
    });
    const rendered = await renderChartView(evidence);
    expect(rendered.metadata.indicators).toEqual([
      { id: "volume", definitionId: "builtin:VOL", version: 1, parameters: {} },
    ]);
    expect((await sharp(rendered.png).metadata()).height).toBe(516);
    evidence.chart.state.indicators[0] = { ...instance, pane: "PRICE" };
    expect((await sharp((await renderChartView(evidence)).png).metadata()).height).toBe(420);
  });
  it("escapes untrusted text; secrets, external images and HTML cannot enter the scene", async () => {
    const evidence = fixture();
    evidence.chart.state.drawings.push({
      id: "note",
      instrumentId: "gold",
      revision: 1,
      creator: "USER",
      creatorId: "owner",
      responsibilityId: null,
      createdAt: evidence.chart.createdAt,
      updatedAt: evidence.chart.updatedAt,
      type: "simpleTag",
      points: [{ time: evidence.candles[12]?.openTime ?? evidence.chart.createdAt, price: "2674" }],
      text: '<image href="https://fixture.invalid/exfil"/>',
      visible: true,
      locked: false,
      evidenceRefs: [],
    });
    const scene = chartScene(evidence);
    expect(scene.svg).not.toContain("<image");
    expect(scene.svg).not.toMatch(/<[a-zA-Z][^>]*\shref=/);
    expect(scene.svg).toContain("&lt;image");
    expect(scene.svg).not.toContain("owner");
    expect(scene.svg).not.toContain("account");
    expect(scene.svg).not.toContain("SECRET_SENTINEL");
    await expect(renderChartView(evidence)).resolves.toBeDefined();
    expect(() => chartScene({ ...evidence, secret: "SECRET_SENTINEL" } as ChartEvidence)).toThrow();
  });
  it("rejects mixed broker identities and duplicate/out-of-order candles", () => {
    const evidence = fixture();
    const candle = evidence.candles[0];
    if (!candle) throw new Error("Fixture");
    evidence.candles[0] = { ...candle, accountId: "other" };
    expect(() => chartScene(evidence)).toThrow("identity");
    evidence.candles[0] = candle;
    evidence.candles.reverse();
    expect(() => chartScene(evidence)).toThrow("time order");
  });
  it("renders empty history without invalid numeric coordinates or chart changes", async () => {
    const evidence = fixture();
    evidence.candles = [];
    const original = JSON.stringify(evidence);
    const scene = chartScene(evidence);
    expect(scene.svg).not.toMatch(/NaN|Infinity/);
    expect(scene.metadata.lastPrice).toBeNull();
    await renderChartView(evidence);
    expect(JSON.stringify(evidence)).toBe(original);
  });
});
