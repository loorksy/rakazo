import type { BrokerCandle, IndicatorDefinition } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateIndicator, validateIndicator } from "./chart-indicator.js";

const swingDefinition: IndicatorDefinition = {
  definitionVersion: 1,
  name: "Confirmed swings",
  description: "Confirm highs/lows after the requested right-side bars.",
  parameters: [
    { name: "left", default: 2, min: 1, max: 16, integer: true },
    { name: "right", default: 3, min: 1, max: 16, integer: true },
  ],
  nodes: [
    { id: "highs", op: "input", field: "high" },
    { id: "lows", op: "input", field: "low" },
    {
      id: "confirmedHigh",
      op: "swing_high",
      input: "highs",
      left: { parameter: "left" },
      right: { parameter: "right" },
      minimumMove: 0,
    },
    {
      id: "confirmedLow",
      op: "swing_low",
      input: "lows",
      left: { parameter: "left" },
      right: { parameter: "right" },
      minimumMove: 0,
    },
  ],
  outputs: [
    {
      id: "high",
      node: "confirmedHigh",
      label: "Confirmed high",
      type: "marker_high",
      pane: "PRICE",
    },
    { id: "low", node: "confirmedLow", label: "Confirmed low", type: "marker_low", pane: "PRICE" },
  ],
};
function candles(values = [10, 11, 20, 12, 11, 10, 12]): BrokerCandle[] {
  return values.map((value, index) => ({
    version: 1,
    provider: "fixture",
    accountId: "account",
    instrumentId: "instrument",
    brokerSymbol: "SYMBOL",
    timeframe: "1h",
    openTime: new Date(Date.UTC(2026, 9, 1, index)).toISOString(),
    open: String(value),
    high: String(value + 1),
    low: String(value - 1),
    close: String(value),
    volume: null,
    complete: true,
    fetchedAt: "2026-10-09T00:00:00Z",
    revision: String(index),
  }));
}
afterEach(() => vi.restoreAllMocks());
describe("safe deterministic indicator IR", () => {
  it("represents a description-driven confirmed swing specification without a fixed strategy", () => {
    expect(validateIndicator(swingDefinition).name).toBe("Confirmed swings");
    const result = calculateIndicator(swingDefinition, candles());
    expect(result.outputs[0]?.values).toEqual([null, null, null, null, null, 21, null]);
    expect(result.outputs[0]?.anchorTimes[5]).toBe(candles()[2]?.openTime);
  });
  it("does not confirm a swing from an unfinished following candle", () => {
    const rows = candles();
    const current = rows[5];
    if (!current) throw new Error("fixture");
    current.complete = false;
    expect(calculateIndicator(swingDefinition, rows).outputs[0]?.values[5]).toBeNull();
  });
  it("is reproducible and has no ambient IO/clock dependency", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Ambient time forbidden");
    });
    const input = candles();
    expect(calculateIndicator(swingDefinition, input)).toEqual(
      calculateIndicator(swingDefinition, input),
    );
  });
  it("handles empty/short history and missing volume", () => {
    expect(
      calculateIndicator(swingDefinition, []).outputs.every((o) => o.values.length === 0),
    ).toBe(true);
    expect(
      calculateIndicator(swingDefinition, candles([2, 3])).outputs.every((o) =>
        o.values.every((v) => v === null),
      ),
    ).toBe(true);
    const volume = {
      ...swingDefinition,
      nodes: [{ id: "volume", op: "input", field: "volume" }] as const,
      outputs: [{ id: "v", node: "volume", label: "Volume", type: "histogram", pane: "SEPARATE" }],
    };
    expect(calculateIndicator(volume, candles()).outputs[0]?.values.every((v) => v === null)).toBe(
      true,
    );
  });
  it.each([0, 17, 2.5, NaN, Infinity])("rejects invalid lookback parameter %s", (right) =>
    expect(() => calculateIndicator(swingDefinition, candles(), { right })).toThrow(),
  );
  it("rejects unknown parameters, forward references and cyclic dependencies", () => {
    expect(() => calculateIndicator(swingDefinition, candles(), { notDeclared: 2 })).toThrow();
    expect(() =>
      validateIndicator({
        ...swingDefinition,
        nodes: [{ id: "bad", op: "shift", input: "bad", bars: 1 }],
      }),
    ).toThrow();
  });
  it.each(["fetch", "eval", "javascript", "python", "filesystem", "process"])(
    "cannot compile an executable %s node",
    (op) => {
      expect(() =>
        validateIndicator({
          ...swingDefinition,
          nodes: [{ id: "malicious", op, code: "fixture-secret-sentinel" }],
        }),
      ).toThrow();
    },
  );
  it("rejects extra uploaded source and excessive bounds before evaluation", () => {
    expect(() =>
      validateIndicator({ ...swingDefinition, source: "import os; read secret" }),
    ).toThrow();
    expect(() =>
      validateIndicator({
        ...swingDefinition,
        nodes: [
          { id: "input", op: "input", field: "close" },
          { id: "tooBig", op: "shift", input: "input", bars: 100000 },
        ],
      }),
    ).toThrow();
    expect(() =>
      calculateIndicator(
        swingDefinition,
        Array.from({ length: 2001 }, () => candles()[0] as BrokerCandle),
      ),
    ).toThrow("candle limit");
  });
  it("rejects mixed accounts/timeframes and unordered evidence", () => {
    const input = candles();
    const last = input.at(-1);
    if (!last) throw new Error("fixture");
    last.accountId = "other";
    expect(() => calculateIndicator(swingDefinition, input)).toThrow("ordered account");
    expect(() => calculateIndicator(swingDefinition, candles().reverse())).toThrow(
      "ordered account",
    );
  });
  it("returns null on division by zero rather than invalid numeric output", () => {
    const definition = {
      ...swingDefinition,
      nodes: [
        { id: "price", op: "input", field: "close" },
        { id: "zero", op: "constant", value: 0 },
        { id: "ratio", op: "divide", a: "price", b: "zero" },
      ],
      outputs: [{ id: "ratio", node: "ratio", label: "Ratio", type: "line", pane: "SEPARATE" }],
    };
    expect(
      calculateIndicator(definition, candles()).outputs[0]?.values.every((v) => v === null),
    ).toBe(true);
  });
  it("supports rolling calculations, shifts, comparisons and conditional outputs", () => {
    const definition = {
      ...swingDefinition,
      parameters: [],
      nodes: [
        { id: "price", op: "input", field: "close" },
        { id: "mean", op: "rolling_mean", input: "price", window: 2 },
        { id: "previous", op: "shift", input: "price", bars: 1 },
        { id: "rising", op: "gt", a: "price", b: "previous" },
        { id: "filtered", op: "if", condition: "rising", whenTrue: "price", whenFalse: "mean" },
      ],
      outputs: [{ id: "filter", node: "filtered", label: "Filter", type: "line", pane: "PRICE" }],
    };
    expect(calculateIndicator(definition, candles([10, 12, 11])).outputs[0]?.values).toEqual([
      null,
      12,
      11.5,
    ]);
  });
  it("bounds aggregate work and memory before processing history", () => {
    const nodes: IndicatorDefinition["nodes"] = [{ id: "price", op: "input", field: "close" }];
    for (let i = 0; i < 20; i++)
      nodes.push({ id: `roll${i}`, op: "rolling_mean", input: "price", window: 512 });
    expect(() =>
      calculateIndicator(
        {
          ...swingDefinition,
          nodes,
          outputs: [{ id: "roll", node: "roll0", label: "Rolling", type: "line", pane: "PRICE" }],
        },
        candles(Array.from({ length: 1000 }, () => 10)),
      ),
    ).toThrow("work budget");
  });
});
