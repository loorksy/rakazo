import { Trans } from "@lingui/react/macro";
import type { ChartCommand, ChartDrawing, ChartEvent, CloudChart } from "@rakazo/contracts";
import { CHART_DRAWING_CAPABILITIES } from "@rakazo/core";
import type { Chart, OverlayEvent } from "klinecharts";
import { ActionType } from "klinecharts";
import { useEffect, useRef, useState } from "react";
import { KlineBrokerDatafeed, klinePeriod } from "../../lib/kline-broker-datafeed";
import { rpc } from "../../lib/rpc";
import "@klinecharts/pro/dist/klinecharts-pro.css";
import "./cloud-chart.css";

/** Solid remains isolated behind the library instance; React owns only the container. */
export function CloudChartView({
  chart,
  event,
  onCommand,
  drawingTool,
}: {
  chart: CloudChart;
  event?: ChartEvent;
  onCommand?: (command: ChartCommand) => Promise<void>;
  drawingTool?: ChartDrawing["type"];
}) {
  const host = useRef<HTMLDivElement>(null);
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const api = useRef<Chart | null>(null);
  const [ready, setReady] = useState(0);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let closed = false;
    let release: (() => void) | undefined;
    const onError = () => {
      if (!closed) setError(true);
    };
    setError(false);
    const datafeed = new KlineBrokerDatafeed(
      chart,
      {
        read: (command, signal) => rpc.trading.read(command, { signal }),
        follow: (accountId, instrumentIds, signal) =>
          rpc.trading.subscribe({ accountId, instrumentIds }, { signal }),
      },
      onError,
    );
    void import("@klinecharts/pro")
      .then(({ KLineChartPro }) => {
        if (closed || !host.current) return;
        const instance = new KLineChartPro({
          container: host.current,
          symbol: {
            ticker: chart.instrumentId,
            name: chart.brokerSymbol,
            shortName: chart.brokerSymbol,
          },
          period: klinePeriod(chart.state.timeframe),
          periods: [klinePeriod(chart.state.timeframe)],
          theme: chart.state.preferences.theme,
          timezone: "UTC",
          locale: "en-US",
          mainIndicators: [],
          subIndicators: [],
          drawingBarVisible: false,
          datafeed,
        });
        api.current = instance.getChartApi();
        const onData = () => {
          if (!closed) setReady((value) => value + 1);
        };
        api.current.subscribeAction(ActionType.OnDataReady, onData);
        release = () => {
          api.current?.unsubscribeAction(ActionType.OnDataReady, onData);
          instance.destroy();
          api.current = null;
        };
        if (closed) release();
        else setReady((value) => value + 1);
      })
      .catch(onError);
    return () => {
      closed = true;
      setCursor(null);
      datafeed.close();
      release?.();
    };
  }, [
    chart.id,
    chart.accountId,
    chart.instrumentId,
    chart.state.timeframe,
    chart.state.preferences.theme,
    chart.state.viewport.from,
    chart.state.viewport.to,
  ]);
  useEffect(() => {
    const native = api.current;
    if (!native) return;
    native.removeOverlay({ groupId: "rakazo-durable" });
    for (const drawing of chart.state.drawings) {
      if (!drawing.visible || drawing.instrumentId !== chart.instrumentId) continue;
      const supported = CHART_DRAWING_CAPABILITIES.some(([id]) => id === drawing.type);
      if (!supported) continue;
      native.createOverlay({
        id: drawing.id,
        groupId: "rakazo-durable",
        name: drawing.type,
        lock: drawing.locked || !onCommand,
        visible: true,
        onPressedMoveEnd: ({ overlay }: OverlayEvent) => {
          try {
            const points = semanticPoints(overlay.points);
            void commandRef
              .current?.({
                operation: "drawing_update",
                chartId: chart.id,
                drawingId: drawing.id,
                expectedDrawingRevision: drawing.revision,
                drawing: {
                  type: drawing.type,
                  points,
                  text: drawing.text,
                  visible: drawing.visible,
                  locked: drawing.locked,
                  evidenceRefs: drawing.evidenceRefs,
                },
              })
              .finally(() => setReady((value) => value + 1));
          } catch {
            setError(true);
            setReady((value) => value + 1);
          }
          return true;
        },
        points: drawing.points.map((point) => ({
          timestamp: Date.parse(point.time),
          value: Number(point.price),
        })),
        extendData: drawing.text,
      });
    }
    native.setOffsetRightDistance(chart.state.viewport.rightSpacing);
    const width = native.getSize()?.width ?? host.current?.clientWidth ?? 800;
    native.setBarSpace(Math.max(2, width / chart.state.viewport.candleCount));
    if (chart.state.viewport.to) native.scrollToTimestamp(Date.parse(chart.state.viewport.to), 0);
    else native.scrollToRealTime(0);
  }, [chart, ready]);
  useEffect(() => {
    const native = api.current;
    if (!native || !drawingTool || !commandRef.current) return;
    native.removeOverlay({ groupId: "rakazo-draft" });
    native.createOverlay({
      name: drawingTool,
      groupId: "rakazo-draft",
      onDrawEnd: ({ overlay }: OverlayEvent) => {
        native.removeOverlay({ id: overlay.id });
        if (
          chartRef.current.id !== chart.id ||
          chartRef.current.instrumentId !== chart.instrumentId
        )
          return true;
        try {
          const points = semanticPoints(overlay.points);
          void commandRef
            .current?.({
              operation: "drawing_create",
              chartId: chart.id,
              expectedRevision: chartRef.current.revision,
              drawing: {
                type: drawingTool,
                points,
                text: "",
                visible: true,
                locked: false,
                evidenceRefs: [],
              },
            })
            .finally(() => setReady((value) => value + 1));
        } catch {
          setError(true);
        }
        return true;
      },
    });
    return () => {
      native.removeOverlay({ groupId: "rakazo-draft" });
    };
  }, [drawingTool, chart.id, chart.instrumentId, ready]);
  useEffect(() => {
    const native = api.current;
    if (
      !native ||
      !event ||
      event.actor !== "BOT" ||
      Date.now() - Date.parse(event.at) > 5000 ||
      !event.points.length
    )
      return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    event.points.forEach((point, index) => {
      timers.push(
        setTimeout(() => {
          const coordinates = native.convertToPixel(
            { timestamp: Date.parse(point.time), value: Number(point.price) },
            { paneId: "candle_pane" },
          );
          if (
            !Array.isArray(coordinates) &&
            typeof coordinates.x === "number" &&
            typeof coordinates.y === "number"
          )
            setCursor({ x: coordinates.x, y: coordinates.y });
        }, index * 180),
      );
    });
    timers.push(setTimeout(() => setCursor(null), event.points.length * 180 + 1200));
    return () => timers.forEach(clearTimeout);
  }, [event, ready]);
  return (
    <div className="rakazo-chart-adapter relative h-full min-h-96 w-full overflow-hidden rounded-xl bg-card">
      <div ref={host} className="h-full min-h-96 w-full" />
      {cursor ? (
        <div
          role="img"
          aria-label="Bot chart cursor"
          className="pointer-events-none absolute z-10 rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-transform duration-150"
          style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)`, left: 0, top: 0 }}
        >
          <Trans>Trading Agent</Trans>
        </div>
      ) : null}
      {error ? (
        <div
          role="status"
          className="absolute bottom-2 left-2 rounded bg-card px-2 py-1 text-xs text-muted-foreground"
        >
          <Trans>Chart data unavailable. Reopen to reconnect.</Trans>
        </div>
      ) : null}
    </div>
  );
}

/** Library coordinates become bounded serializable chart semantics, never financial execution. */
function semanticPoints(points: Array<{ timestamp?: number; value?: number }>) {
  return points.map((point) => {
    if (
      !Number.isFinite(point.timestamp) ||
      !Number.isFinite(point.value) ||
      point.value === undefined ||
      point.timestamp === undefined ||
      point.value <= 0
    )
      throw new Error("Invalid chart anchor");
    return {
      time: new Date(point.timestamp).toISOString(),
      price: point.value.toFixed(12).replace(/\.?0+$/, ""),
    };
  });
}
