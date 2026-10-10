// @vitest-environment jsdom

import { CloudChartSchema } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  charts: vi.fn(),
  read: vi.fn(),
  chartEvents: vi.fn(),
  indicators: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    trading: {
      connections: { list: api.list },
      charts: api.charts,
      read: api.read,
      chartEvents: api.chartEvents,
      indicators: api.indicators,
    },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
vi.mock("./CloudChartView", () => ({
  CloudChartView: ({ chart }: { chart: { id: string } }) => (
    <div data-testid="saved-chart">{chart.id}</div>
  ),
}));

import { CloudChartPanel } from "./CloudChartPanel";

const time = "2026-10-09T08:00:00Z";
const chart = CloudChartSchema.parse({
  id: "persisted-chart",
  ownerUserId: "owner",
  ownerBotId: null,
  scope: "PRIVATE",
  accountId: "account",
  instrumentId: "instrument",
  brokerSymbol: "GOLD.a",
  revision: 1,
  state: {
    version: 1,
    timeframe: "1h",
    viewport: { from: null, to: null, candleCount: 200, rightSpacing: 40 },
    drawings: [],
    indicators: [],
    preferences: { theme: "dark", timezone: "UTC" },
  },
  createdAt: time,
  updatedAt: time,
});
let root: Root | undefined;
let host: HTMLDivElement | undefined;
async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<CloudChartPanel />));
}
function fixtures() {
  api.indicators.mockResolvedValue([]);
  api.list.mockResolvedValue([{ id: "account", label: "Fixture", revokedAt: null }]);
  api.charts.mockResolvedValue([chart]);
  api.read.mockResolvedValue([
    {
      id: "instrument",
      accountId: "account",
      brokerSymbol: "GOLD.a",
      displayName: "Gold",
      verifiedAt: time,
    },
  ]);
  api.chartEvents.mockResolvedValue(
    (async function* () {
      yield {
        chartId: chart.id,
        revision: 1,
        actor: "USER",
        operation: "SYNC",
        at: time,
        points: [],
      };
    })(),
  );
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.resetAllMocks();
});
it("restores backend state after client close and reuses an existing account-scoped chart", async () => {
  fixtures();
  await render();
  expect(host?.querySelector('[data-testid="saved-chart"]')?.textContent).toBe(chart.id);
  const open = [...(host?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === "Open chart",
  );
  await act(async () => open?.click());
  expect(api.charts.mock.calls.every(([cmd]) => cmd.operation === "list")).toBe(true);
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  await render();
  expect(host?.querySelector('[data-testid="saved-chart"]')?.textContent).toBe(chart.id);
});
it("saves timeframe changes through the authoritative revision boundary", async () => {
  fixtures();
  await render();
  api.charts.mockResolvedValue({
    ...chart,
    revision: 2,
    state: { ...chart.state, timeframe: "4h" },
  });
  const select = host?.querySelector('[aria-label="Timeframe"]');
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing timeframe");
  await act(async () => {
    select.value = "4h";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.charts).toHaveBeenCalledWith({
    operation: "set_timeframe",
    chartId: chart.id,
    expectedRevision: 1,
    timeframe: "4h",
  });
  expect(select.value).toBe("4h");
});
it("reloads authoritative state after a conflict and preserves a calm error", async () => {
  fixtures();
  await render();
  api.charts
    .mockRejectedValueOnce(new Error("fixture-secret-sentinel"))
    .mockResolvedValueOnce({ ...chart, revision: 2 });
  const zoom = host?.querySelector('[aria-label="Zoom in"]');
  await act(async () => {
    if (zoom instanceof HTMLButtonElement) zoom.click();
  });
  expect(api.charts).toHaveBeenCalledWith({ operation: "get", chartId: chart.id });
  expect(host?.textContent).not.toContain("fixture-secret-sentinel");
  expect(host?.querySelector('[role="status"]')).not.toBeNull();
});
