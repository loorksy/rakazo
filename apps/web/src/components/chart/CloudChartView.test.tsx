// @vitest-environment jsdom

import type { ChartEvent } from "@rakazo/contracts";
import { CloudChartSchema } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  subscribeAction: vi.fn(),
  unsubscribeAction: vi.fn(),
  removeIndicator: vi.fn(),
  createIndicator: vi.fn(),
  removeOverlay: vi.fn(),
  createOverlay: vi.fn(),
  setOffsetRightDistance: vi.fn(),
  getSize: vi.fn(() => ({ width: 800 })),
  setBarSpace: vi.fn(),
  scrollToTimestamp: vi.fn(),
  scrollToRealTime: vi.fn(),
  convertToPixel: vi.fn(() => ({ x: 120, y: 40 })),
}));
const vendor = vi.hoisted(() => ({ destroy: vi.fn(), options: vi.fn() }));
const reads = vi.hoisted(() => ({ read: vi.fn(), subscribe: vi.fn() }));
vi.mock("@klinecharts/pro", () => ({
  KLineChartPro: class {
    constructor(options: unknown) {
      vendor.options(options);
    }
    getChartApi() {
      return native;
    }
    destroy() {
      vendor.destroy();
    }
  },
}));
vi.mock("../../lib/rpc", () => ({ rpc: { trading: reads } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { CloudChartView } from "./CloudChartView";

const time = "2026-10-09T08:00:00Z";
const chart = CloudChartSchema.parse({
  id: "chart",
  ownerUserId: "owner",
  ownerBotId: null,
  scope: "MAIN",
  accountId: "account",
  instrumentId: "instrument",
  brokerSymbol: "GOLD.a",
  revision: 1,
  state: {
    version: 1,
    timeframe: "1h",
    viewport: { from: null, to: null, candleCount: 200, rightSpacing: 40 },
    drawings: [
      {
        id: "line",
        instrumentId: "instrument",
        revision: 1,
        type: "horizontalStraightLine",
        points: [{ time, price: "2700.123456789" }],
        text: "Support",
        visible: true,
        locked: false,
        evidenceRefs: [],
        creator: "BOT",
        creatorId: "main-bot",
        responsibilityId: null,
        createdAt: time,
        updatedAt: time,
      },
    ],
    indicators: [],
    preferences: { theme: "dark", timezone: "UTC" },
  },
  createdAt: time,
  updatedAt: time,
});
let root: Root | undefined;
let host: HTMLDivElement | undefined;
async function render(event?: ChartEvent) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<CloudChartView chart={chart} event={event} />));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});
it("projects durable semantic drawings and destroys the isolated library on close", async () => {
  await render();
  expect(vendor.options).toHaveBeenCalledWith(
    expect.objectContaining({
      mainIndicators: [],
      subIndicators: [],
      symbol: expect.objectContaining({ ticker: "instrument" }),
    }),
  );
  expect(native.createOverlay).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "line",
      name: "horizontalStraightLine",
      points: [{ timestamp: Date.parse(time), value: 2700.123456789 }],
    }),
  );
  expect(chart.state.drawings[0]?.points[0]?.price).toBe("2700.123456789");
  const options = vendor.options.mock.calls[0]?.[0];
  const readSpy = reads.read.mockImplementation(
    async (_cmd: unknown, { signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(true);
      return [];
    },
  );
  await act(async () => root?.unmount());
  root = undefined;
  expect(vendor.destroy).toHaveBeenCalledOnce();
  await options.datafeed.getHistoryKLineData(
    { ticker: "instrument" },
    { multiplier: 1, timespan: "hour" },
    0,
    Date.now(),
  );
  expect(readSpy).toHaveBeenCalledOnce();
  await render();
  expect(native.createOverlay).toHaveBeenCalledTimes(2);
  expect(chart.revision).toBe(1);
});
it("uses a virtual semantic Bot cursor without moving the user pointer or changing persisted points", async () => {
  vi.useFakeTimers();
  const event: ChartEvent = {
    chartId: chart.id,
    revision: 2,
    actor: "BOT",
    operation: "drawing_create",
    at: new Date().toISOString(),
    points: [{ time, price: "2701.5" }],
  };
  await render(event);
  await act(async () => vi.advanceTimersByTime(0));
  expect(native.convertToPixel).toHaveBeenCalledWith(
    { timestamp: Date.parse(time), value: 2701.5 },
    { paneId: "candle_pane" },
  );
  expect(host?.querySelector('[aria-label="Bot chart cursor"]')?.textContent).toBe("Trading Agent");
  expect(chart.state.drawings[0]?.points[0]?.price).toBe("2700.123456789");
  await act(async () => vi.advanceTimersByTime(1500));
  expect(host?.querySelector('[aria-label="Bot chart cursor"]')).toBeNull();
});
it("does not replay old Bot cursor movements after reconnect", async () => {
  await render({
    chartId: chart.id,
    revision: 2,
    actor: "BOT",
    operation: "drawing_create",
    at: "2000-01-01T00:00:00Z",
    points: [{ time, price: "2701" }],
  });
  expect(native.convertToPixel).not.toHaveBeenCalled();
  expect(host?.querySelector('[aria-label="Bot chart cursor"]')).toBeNull();
});
