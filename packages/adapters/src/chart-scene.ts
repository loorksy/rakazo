import type { AgentToolExecutionResult } from "@rakazo/adapter-kit";
import type { BrokerCandle, ChartDrawing, ChartEvidence } from "@rakazo/contracts";
import { ChartEvidenceSchema, ChartRenderMetadataSchema } from "@rakazo/contracts";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import sharp from "sharp";

const WIDTH = 960;
const PRICE_HEIGHT = 420;
const PANE_HEIGHT = 96;
const LEFT = 16;
const RIGHT = 86;
const TOP = 42;
const BOTTOM = 30;
function escapeText(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}
/** Shared viewport projection; exact prices remain strings in evidence, never inferred from pixels. */
export function visibleChartCandles(evidence: ChartEvidence): BrokerCandle[] {
  const { from, to, candleCount } = evidence.chart.state.viewport;
  return evidence.candles
    .filter(
      (c) =>
        (!from || Date.parse(c.openTime) >= Date.parse(from)) &&
        (!to || Date.parse(c.openTime) <= Date.parse(to)),
    )
    .slice(-candleCount);
}

/** Deterministic chart-only document. Every markup fragment is generated here, never supplied by a model. */
export function chartScene(raw: ChartEvidence) {
  const evidence = ChartEvidenceSchema.parse(raw);
  const { chart, calculations } = evidence;
  if (
    evidence.candles.some(
      (c) =>
        c.accountId !== chart.accountId ||
        c.instrumentId !== chart.instrumentId ||
        c.timeframe !== chart.state.timeframe,
    )
  )
    throw new Error("Chart scene identity mismatch");
  const candles = visibleChartCandles(evidence);
  const times = candles.map((c) => Date.parse(c.openTime));
  if (times.some((t, i) => i > 0 && t <= (times[i - 1] ?? t)))
    throw new Error("Chart scene time order");
  const timeIndexes = new Map(times.map((time, index) => [time, index]));
  const palette = tokensForAppearance(chart.state.preferences.theme);
  const indicators = chart.state.indicators.filter((i) => i.visible);
  const panes = indicators.filter((i) => i.pane === "SEPARATE");
  for (const instance of indicators) {
    const result = calculations.find((r) => r.instanceId === instance.id);
    if (
      !result ||
      result.definitionId !== instance.definitionId ||
      result.definitionVersion !== instance.definitionVersion ||
      Object.entries(instance.parameters).some(([key, value]) => result.parameters[key] !== value)
    )
      throw new Error("Chart indicator evidence mismatch");
    if (
      result.outputs.some(
        (o) =>
          o.values.length !== result.times.length || o.anchorTimes.length !== result.times.length,
      )
    )
      throw new Error("Chart indicator series mismatch");
  }
  const height = PRICE_HEIGHT + panes.length * PANE_HEIGHT;
  const plotRight = WIDTH - RIGHT - chart.state.viewport.rightSpacing;
  const step = (plotRight - LEFT) / Math.max(candles.length, 1);
  const xIndex = (i: number) => LEFT + (i + 0.5) * step;
  const xTime = (time: string) => {
    const t = Date.parse(time);
    const exact = timeIndexes.get(t);
    if (exact !== undefined) return xIndex(exact);
    if (!times.length) return LEFT;
    const index = times.findIndex((value) => value >= t);
    const edgeSpacing = times.length > 1 ? (times[1] ?? t) - (times[0] ?? t) : 3600000;
    if (index === 0) return xIndex((t - (times[0] ?? t)) / edgeSpacing);
    if (index < 0) return xIndex(times.length - 1 + (t - (times.at(-1) ?? t)) / edgeSpacing);
    const previous = times[index - 1] ?? t;
    return xIndex(index - 1 + (t - previous) / ((times[index] ?? t) - previous));
  };
  const priceValues = candles.flatMap((c) => [Number(c.high), Number(c.low)]);
  for (const instance of indicators.filter((i) => i.pane === "PRICE")) {
    const result = calculations.find((r) => r.instanceId === instance.id);
    for (const out of result?.outputs ?? [])
      out.values.forEach((v, i) => {
        const t = out.anchorTimes[i] ?? result?.times[i];
        if (v !== null && t && timeIndexes.has(Date.parse(t)) && out.type !== "state")
          priceValues.push(v);
      });
  }
  const bounds = (values: number[]) => {
    const low = values.length ? values.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    const high = values.length ? values.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
    const pad = Math.max((high - low) * 0.08, Math.abs(high) * 0.000001, 0.000001);
    return { low: low - pad, high: high + pad };
  };
  const priceBounds = bounds(priceValues);
  const priceY = (price: number) =>
    TOP +
    ((priceBounds.high - price) / (priceBounds.high - priceBounds.low)) *
      (PRICE_HEIGHT - TOP - BOTTOM);
  const line = (x1: number, y1: number, x2: number, y2: number, color = palette.foreground) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.2"/>`;
  const text = (x: number, y: number, value: string, color = palette.mutedForeground) =>
    `<text x="${x}" y="${y}" fill="${color}" font-size="12">${escapeText(value)}</text>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}"><rect width="${WIDTH}" height="${height}" fill="${palette.background}"/><g font-family="DejaVu Sans, sans-serif">`,
    text(LEFT, 24, `${chart.brokerSymbol} · ${chart.state.timeframe} · UTC`, palette.foreground),
    `<defs><clipPath id="price"><rect x="${LEFT}" y="${TOP}" width="${WIDTH - RIGHT - LEFT}" height="${PRICE_HEIGHT - TOP - BOTTOM}"/></clipPath></defs>`,
  ];
  for (let i = 0; i <= 4; i++) {
    const value = priceBounds.low + ((priceBounds.high - priceBounds.low) * i) / 4;
    parts.push(
      line(LEFT, priceY(value), WIDTH - RIGHT, priceY(value), palette.border),
      text(WIDTH - RIGHT + 6, priceY(value) + 4, value.toPrecision(8)),
    );
  }
  parts.push('<g clip-path="url(#price)">');
  candles.forEach((c, i) => {
    const color = Number(c.close) >= Number(c.open) ? palette.success : palette.destructive;
    const x = xIndex(i);
    const y = Math.min(priceY(Number(c.open)), priceY(Number(c.close)));
    parts.push(
      line(x, priceY(Number(c.high)), x, priceY(Number(c.low)), color),
      `<rect x="${x - Math.max(1, step * 0.3)}" y="${y}" width="${Math.max(2, step * 0.6)}" height="${Math.max(1, Math.abs(priceY(Number(c.open)) - priceY(Number(c.close))))}" fill="${color}"/>`,
    );
  });
  const draw = (drawing: ChartDrawing) => {
    const p = drawing.points.map((v) => ({ x: xTime(v.time), y: priceY(Number(v.price)) }));
    const a = p[0];
    const b = p[1];
    const c = p[2];
    if (!a) return;
    const extend = (from: number, to: number, offset = 0) => {
      if (!b || b.x === a.x) return line(a.x, TOP, a.x, PRICE_HEIGHT - BOTTOM);
      const y = (x: number) => a.y + ((x - a.x) * (b.y - a.y)) / (b.x - a.x) + offset;
      return line(from, y(from), to, y(to));
    };
    switch (drawing.type) {
      case "horizontalStraightLine":
        parts.push(line(LEFT, a.y, WIDTH - RIGHT, a.y));
        break;
      case "verticalStraightLine":
        parts.push(line(a.x, TOP, a.x, PRICE_HEIGHT - BOTTOM));
        break;
      case "priceLine":
        parts.push(line(a.x, a.y, WIDTH - RIGHT, a.y));
        break;
      case "simpleAnnotation":
      case "simpleTag":
        parts.push(`<circle cx="${a.x}" cy="${a.y}" r="3" fill="${palette.foreground}"/>`);
        break;
      case "segment":
        if (b) parts.push(line(a.x, a.y, b.x, b.y));
        break;
      case "rayLine":
        if (b) parts.push(extend(a.x, b.x >= a.x ? WIDTH - RIGHT : LEFT));
        break;
      case "straightLine":
        parts.push(extend(LEFT, WIDTH - RIGHT));
        break;
      case "parallelStraightLine":
      case "priceChannelLine":
        if (b && c) {
          if (b.x === a.x) {
            parts.push(
              line(a.x, TOP, a.x, PRICE_HEIGHT - BOTTOM),
              line(c.x, TOP, c.x, PRICE_HEIGHT - BOTTOM),
            );
            if (drawing.type === "priceChannelLine")
              parts.push(line(2 * a.x - c.x, TOP, 2 * a.x - c.x, PRICE_HEIGHT - BOTTOM));
          } else {
            const offset = c.y - (a.y + ((c.x - a.x) * (b.y - a.y)) / (b.x - a.x));
            parts.push(extend(LEFT, WIDTH - RIGHT), extend(LEFT, WIDTH - RIGHT, offset));
            if (drawing.type === "priceChannelLine")
              parts.push(extend(LEFT, WIDTH - RIGHT, -offset));
          }
        }
        break;
      case "rect":
        if (b)
          parts.push(
            `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(a.x - b.x)}" height="${Math.abs(a.y - b.y)}" fill="${palette.muted}" fill-opacity="0.5" stroke="${palette.foreground}"/>`,
          );
        break;
      case "triangle":
        if (b && c)
          parts.push(
            `<polygon points="${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}" fill="${palette.muted}" fill-opacity="0.5" stroke="${palette.foreground}"/>`,
          );
        break;
      case "fibonacciLine":
      case "fibonacciSegment":
        if (b)
          for (const ratio of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
            const y = b.y + (a.y - b.y) * ratio;
            parts.push(
              line(
                drawing.type === "fibonacciLine" ? LEFT : Math.min(a.x, b.x),
                y,
                drawing.type === "fibonacciLine" ? WIDTH - RIGHT : Math.max(a.x, b.x),
                y,
              ),
              text(Math.min(a.x, b.x) + 4, y - 3, String(ratio)),
            );
          }
        break;
    }
    if (drawing.text) parts.push(text(a.x + 5, a.y - 6, drawing.text, palette.foreground));
  };
  for (const drawing of chart.state.drawings.filter(
    (d) => d.visible && d.instrumentId === chart.instrumentId,
  ))
    draw(drawing);
  parts.push("</g>");
  for (const instance of indicators) {
    const result = calculations.find((r) => r.instanceId === instance.id);
    if (!result) continue;
    const paneIndex = panes.findIndex((p) => p.id === instance.id);
    const paneTop = PRICE_HEIGHT + Math.max(0, paneIndex) * PANE_HEIGHT;
    const values = result.outputs
      .filter((o) => o.type !== "state")
      .flatMap((o) =>
        o.values.filter((v, index): v is number => {
          const time = o.anchorTimes[index] ?? result.times[index];
          return v !== null && !!time && timeIndexes.has(Date.parse(time));
        }),
      );
    const range = bounds([...values, 0]);
    const y =
      instance.pane === "PRICE"
        ? priceY
        : (v: number) =>
            paneTop + 22 + ((range.high - v) / (range.high - range.low)) * (PANE_HEIGHT - 30);
    if (instance.pane === "SEPARATE")
      parts.push(
        line(LEFT, paneTop, WIDTH - RIGHT, paneTop, palette.border),
        text(LEFT, paneTop + 16, `${instance.definitionId} v${instance.definitionVersion}`),
      );
    parts.push(instance.pane === "PRICE" ? '<g clip-path="url(#price)">' : "<g>");
    for (const out of result.outputs) {
      if (out.type === "state") continue;
      let previous: { x: number; y: number } | undefined;
      out.values.forEach((v, i) => {
        const t = out.anchorTimes[i] ?? result.times[i];
        if (v === null || !t || !timeIndexes.has(Date.parse(t))) {
          previous = undefined;
          return;
        }
        const x = xTime(t);
        const py = y(v);
        if (out.type.startsWith("marker_"))
          parts.push(`<circle cx="${x}" cy="${py}" r="3" fill="${palette.warning}"/>`);
        else if (out.type === "histogram") parts.push(line(x, y(0), x, py, palette.foreground));
        else if (previous) parts.push(line(previous.x, previous.y, x, py, palette.foreground));
        previous = { x, y: py };
      });
    }
    parts.push("</g>");
  }
  const first = candles[0];
  const last = candles.at(-1);
  if (first) parts.push(text(LEFT, PRICE_HEIGHT - 8, first.openTime));
  if (last) parts.push(text(Math.max(LEFT, plotRight - 180), PRICE_HEIGHT - 8, last.openTime));
  parts.push("</g></svg>");
  return {
    svg: parts.join(""),
    metadata: ChartRenderMetadataSchema.parse({
      renderer: "chart-svg-v1",
      chartId: chart.id,
      chartRevision: chart.revision,
      instrumentId: chart.instrumentId,
      brokerSymbol: chart.brokerSymbol,
      timeframe: chart.state.timeframe,
      visibleCandleCount: candles.length,
      visibleFrom: first?.openTime ?? null,
      visibleTo: last?.openTime ?? null,
      lastPrice: last?.close ?? null,
      lastCompletedCandle: candles.findLast((c) => c.complete)?.openTime ?? null,
      provider: last?.provider ?? null,
      fetchedAt: last?.fetchedAt ?? null,
      drawingIds: chart.state.drawings
        .filter((d) => d.visible && d.instrumentId === chart.instrumentId)
        .map((d) => d.id),
      indicators: indicators.map((i) => ({
        id: i.id,
        definitionId: i.definitionId,
        version: i.definitionVersion,
        parameters: i.parameters,
      })),
      width: WIDTH,
      height,
    }),
  };
}

export async function renderChartView(evidence: ChartEvidence) {
  const scene = chartScene(evidence);
  const png = await sharp(Buffer.from(scene.svg), { limitInputPixels: 4_000_000 }).png().toBuffer();
  return { png, metadata: scene.metadata };
}

/** Vision is optional; non-image runtimes still receive the exact same operational evidence. */
export function chartVisionResult(
  evidence: ChartEvidence,
  rendered: Awaited<ReturnType<typeof renderChartView>>,
  acceptsImages: boolean,
  artifactId?: string,
): AgentToolExecutionResult {
  const details = {
    ...rendered.metadata,
    artifactId: artifactId ?? null,
    visionAvailable: acceptsImages,
    candles: visibleChartCandles(evidence),
    calculations: evidence.calculations,
  };
  return {
    kind: "agent_tool_result",
    content: [
      { type: "text", text: JSON.stringify(details) },
      ...(acceptsImages
        ? [
            {
              type: "image" as const,
              data: rendered.png.toString("base64"),
              mimeType: "image/png" as const,
            },
          ]
        : []),
    ],
    details,
  };
}
