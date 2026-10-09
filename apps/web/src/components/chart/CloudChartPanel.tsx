import { Trans } from "@lingui/react/macro";
import type {
  BrokerInstrumentDirectory,
  ChartCommand,
  ChartDrawing,
  ChartEvent,
  CloudChart,
  CustomIndicator,
  TradingConnectionView,
} from "@rakazo/contracts";
import {
  BrokerInstrumentDirectorySchema,
  BrokerTimeframeSchema,
  CloudChartSchema,
  CustomIndicatorSchema,
} from "@rakazo/contracts";
import { CHART_DRAWING_CAPABILITIES } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { CloudChartView } from "./CloudChartView";
export function CloudChartPanel() {
  const [chart, setChart] = useState<CloudChart | null>(null);
  const [charts, setCharts] = useState<CloudChart[]>([]);
  const [connections, setConnections] = useState<TradingConnectionView[]>([]);
  const [accountId, setAccountId] = useState("");
  const [directory, setDirectory] = useState<BrokerInstrumentDirectory>([]);
  const [instrumentId, setInstrumentId] = useState("");
  const [indicators, setIndicators] = useState<CustomIndicator[]>([]);
  const [indicatorId, setIndicatorId] = useState("");
  const [drawingTool, setDrawingTool] = useState<ChartDrawing["type"]>();
  const [event, setEvent] = useState<ChartEvent | undefined>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef(chart);
  current.current = chart;
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      rpc.trading.connections.list(undefined, { signal: abort.signal }),
      rpc.trading.charts({ operation: "list" }, { signal: abort.signal }),
    ])
      .then(([accounts, raw]) => {
        if (abort.signal.aborted) return;
        const list = CloudChartSchema.array().parse(raw);
        setCharts(list);
        setChart(list.find((row) => row.scope === "MAIN") ?? list[0] ?? null);
        const available = accounts.filter((row) => !row.revokedAt);
        setConnections(available);
        setAccountId(available[0]?.id ?? "");
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void rpc.trading
      .indicators({ operation: "search", query: "" }, { signal: abort.signal })
      .then((raw) => {
        if (!abort.signal.aborted) setIndicators(CustomIndicatorSchema.array().parse(raw));
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!accountId) return;
    const abort = new AbortController();
    setDirectory([]);
    setInstrumentId("");
    setBusy(true);
    void rpc.trading
      .read({ operation: "instruments", accountId }, { signal: abort.signal })
      .then((raw) => {
        if (abort.signal.aborted) return;
        const rows = BrokerInstrumentDirectorySchema.parse(raw);
        setDirectory(rows);
        setInstrumentId(rows[0]?.id ?? "");
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [accountId]);
  useEffect(() => {
    if (!chart) return;
    const abort = new AbortController();
    void (async () => {
      const stream = await rpc.trading.chartEvents({ chartId: chart.id }, { signal: abort.signal });
      for await (const update of stream) {
        if (abort.signal.aborted) break;
        if (update.actor === "BOT" && Date.now() - Date.parse(update.at) <= 5000) setEvent(update);
        if (update.revision > (current.current?.revision ?? 0)) {
          const restored = CloudChartSchema.parse(
            await rpc.trading.charts(
              { operation: "get", chartId: chart.id },
              { signal: abort.signal },
            ),
          );
          if (!abort.signal.aborted)
            setChart((previous) =>
              !previous || restored.revision >= previous.revision ? restored : previous,
            );
        }
      }
    })().catch(() => {
      if (!abort.signal.aborted) setError(true);
    });
    return () => {
      abort.abort();
      setEvent(undefined);
    };
  }, [chart?.id]);
  async function command(cmd: ChartCommand) {
    if (busy) return;
    const existing =
      cmd.operation === "create"
        ? charts.find(
            (row) =>
              row.accountId === cmd.accountId &&
              row.instrumentId === cmd.instrumentId &&
              row.scope === cmd.scope,
          )
        : undefined;
    if (existing) {
      setChart(existing);
      return;
    }
    setBusy(true);
    setError(false);
    try {
      const next = CloudChartSchema.parse(await rpc.trading.charts(cmd));
      setChart(next);
      setCharts((rows) => [next, ...rows.filter((row) => row.id !== next.id)]);
    } catch {
      setError(true);
      if (current.current) {
        try {
          const restored = CloudChartSchema.parse(
            await rpc.trading.charts({ operation: "get", chartId: current.current.id }),
          );
          setChart(restored);
        } catch {
          /* Keep the last valid snapshot on network failure. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const selectClass =
    "min-w-0 rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground";
  return (
    <div className="flex h-full min-h-96 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {charts.length ? (
          <select
            aria-label="Saved chart"
            className={selectClass}
            value={chart?.id ?? ""}
            onChange={(e) => setChart(charts.find((row) => row.id === e.target.value) ?? null)}
          >
            {charts.map((row) => (
              <option key={row.id} value={row.id}>
                {row.brokerSymbol} · {row.state.timeframe}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Broker account"
          className={selectClass}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {connections.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Broker instrument"
          className={selectClass}
          value={instrumentId}
          onChange={(e) => setInstrumentId(e.target.value)}
        >
          {directory.map((row) => (
            <option key={row.id} value={row.id}>
              {row.brokerSymbol}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !instrumentId}
          onClick={() =>
            void command({
              operation: "create",
              accountId,
              instrumentId,
              timeframe: "1h",
              scope: "MAIN",
            })
          }
        >
          <Trans>Open chart</Trans>
        </Button>
      </div>
      {chart ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{chart.brokerSymbol}</span>
            <select
              aria-label="Timeframe"
              className={selectClass}
              value={chart.state.timeframe}
              disabled={busy}
              onChange={(e) =>
                void command({
                  operation: "set_timeframe",
                  chartId: chart.id,
                  expectedRevision: chart.revision,
                  timeframe: BrokerTimeframeSchema.parse(e.target.value),
                })
              }
            >
              {BrokerTimeframeSchema.options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void command({
                  operation: "zoom",
                  chartId: chart.id,
                  expectedRevision: chart.revision,
                  factor: 2,
                })
              }
              aria-label="Zoom in"
            >
              +
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void command({
                  operation: "zoom",
                  chartId: chart.id,
                  expectedRevision: chart.revision,
                  factor: 0.5,
                })
              }
              aria-label="Zoom out"
            >
              −
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                void command({
                  operation: "reset_view",
                  chartId: chart.id,
                  expectedRevision: chart.revision,
                })
              }
            >
              <Trans>Reset view</Trans>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Drawing tool"
              className={selectClass}
              value={drawingTool ?? ""}
              disabled={busy}
              onChange={(e) =>
                setDrawingTool(
                  CHART_DRAWING_CAPABILITIES.find(([id]) => id === e.target.value)?.[0],
                )
              }
            >
              <option value="">
                <Trans>Draw</Trans>
              </option>
              {CHART_DRAWING_CAPABILITIES.map(([id]) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Indicator"
              className={selectClass}
              value={indicatorId}
              onChange={(e) => setIndicatorId(e.target.value)}
            >
              <option value="">
                <Trans>Indicator</Trans>
              </option>
              {indicators.map((i) => (
                <option key={`${i.id}:${i.version}`} value={`${i.id}:${i.version}`}>
                  {i.definition.name} · v{i.version}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !indicatorId}
              onClick={() => {
                const item = indicators.find((i) => `${i.id}:${i.version}` === indicatorId);
                if (item)
                  void command({
                    operation: "indicator_add",
                    chartId: chart.id,
                    expectedRevision: chart.revision,
                    indicator: {
                      definitionId: item.id,
                      definitionVersion: item.version,
                      parameters: {},
                      pane: item.definition.outputs[0]?.pane ?? "PRICE",
                      visible: true,
                    },
                  });
              }}
            >
              <Trans>Add</Trans>
            </Button>
            {chart.state.indicators.map((i) => (
              <Button
                key={i.id}
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void command({
                    operation: "indicator_remove",
                    chartId: chart.id,
                    indicatorId: i.id,
                    expectedIndicatorRevision: i.revision,
                  })
                }
              >
                {i.definitionId} ×
              </Button>
            ))}
          </div>
          <div className="min-h-96 flex-1">
            <CloudChartView
              chart={chart}
              event={event}
              drawingTool={drawingTool}
              onCommand={command}
            />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>Choose a connected account and broker instrument.</Trans>
        </p>
      )}
      {error ? (
        <p role="status" className="text-sm text-destructive">
          <Trans>Chart changed or data is unavailable. Reopen to refresh.</Trans>
        </p>
      ) : null}
    </div>
  );
}
