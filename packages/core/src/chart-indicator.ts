import type { BrokerCandle, IndicatorDefinition, IndicatorNode } from "@rakazo/contracts";
import { BrokerCandleSchema, IndicatorDefinitionSchema } from "@rakazo/contracts";

export class IndicatorValidationError extends Error {
  constructor(message = "Invalid safe indicator definition") {
    super(message);
  }
}
const MAX_WORK = 2_000_000;
function refs(node: IndicatorNode): string[] {
  if ("a" in node) return [node.a, node.b];
  if ("condition" in node) return [node.condition, node.whenTrue, node.whenFalse];
  if ("input" in node) return [node.input];
  return [];
}
function windows(node: IndicatorNode) {
  if ("window" in node) return [node.window];
  if ("bars" in node) return [node.bars];
  if ("left" in node) return [node.left, node.right];
  return [];
}
export function validateIndicator(raw: unknown): IndicatorDefinition {
  const definition = IndicatorDefinitionSchema.parse(raw);
  const parameters = new Map(definition.parameters.map((p) => [p.name, p]));
  if (parameters.size !== definition.parameters.length)
    throw new IndicatorValidationError("Duplicate indicator parameter");
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id) || refs(node).some((id) => !ids.has(id)))
      throw new IndicatorValidationError("Nodes must be unique and refer only to earlier nodes");
    if (node.op === "parameter" && !parameters.has(node.parameter))
      throw new IndicatorValidationError("Unknown indicator parameter");
    for (const window of windows(node)) {
      if (typeof window !== "number") {
        const p = parameters.get(window.parameter);
        if (!p?.integer || p.min < 1 || p.max > 512)
          throw new IndicatorValidationError("Window parameters require bounded positive integers");
      }
    }
    if ("minimumMove" in node && node.minimumMove < 0)
      throw new IndicatorValidationError("Minimum move cannot be negative");
    ids.add(node.id);
  }
  const outputs = new Set<string>();
  for (const out of definition.outputs) {
    if (!ids.has(out.node) || outputs.has(out.id))
      throw new IndicatorValidationError("Invalid or duplicate indicator output");
    outputs.add(out.id);
  }
  return definition;
}
export function indicatorParameters(
  definition: IndicatorDefinition,
  raw: Record<string, number>,
): Record<string, number> {
  const params: Record<string, number> = {};
  for (const key of Object.keys(raw))
    if (!definition.parameters.some((p) => p.name === key))
      throw new IndicatorValidationError("Unknown indicator parameter");
  for (const p of definition.parameters) {
    const value = raw[p.name] ?? p.default;
    if (
      !Number.isFinite(value) ||
      value < p.min ||
      value > p.max ||
      (p.integer && !Number.isInteger(value))
    )
      throw new IndicatorValidationError("Indicator parameter outside bounds");
    params[p.name] = value;
  }
  return params;
}
/** Pure bounded analytical computation. It cannot authorize financial prices, quantities or risk. */
export function calculateIndicator(
  raw: unknown,
  input: BrokerCandle[],
  parameters: Record<string, number> = {},
) {
  const definition = validateIndicator(raw),
    params = indicatorParameters(definition, parameters);
  if (input.length > 2000) throw new IndicatorValidationError("Indicator candle limit exceeded");
  const candles = input.map((c) => BrokerCandleSchema.parse(c));
  for (let i = 1; i < candles.length; i++) {
    const before = candles[i - 1],
      after = candles[i];
    if (
      !before ||
      !after ||
      Date.parse(before.openTime) >= Date.parse(after.openTime) ||
      before.accountId !== after.accountId ||
      before.instrumentId !== after.instrumentId ||
      before.timeframe !== after.timeframe
    )
      throw new IndicatorValidationError(
        "Indicator input must be one ordered account/instrument/timeframe",
      );
  }
  const resolve = (window: number | { parameter: string }) =>
    typeof window === "number" ? window : (params[window.parameter] ?? 0);
  let cost = 0;
  for (const node of definition.nodes)
    cost += Math.max(
      1,
      windows(node).reduce<number>((sum, w) => sum + resolve(w), 0),
    );
  if (cost * Math.max(1, candles.length) > MAX_WORK)
    throw new IndicatorValidationError("Indicator work budget exceeded");
  const series = new Map<string, Array<number | null>>();
  const value = (id: string, index: number) => series.get(id)?.[index] ?? null;
  const bounded = (v: number | null) =>
    v !== null && Number.isFinite(v) && Math.abs(v) <= 1e18 ? v : null;
  for (const node of definition.nodes) {
    const rows: Array<number | null> = [];
    for (let i = 0; i < candles.length; i++) {
      let out: number | null = null;
      if (node.op === "input") {
        const field = candles[i]?.[node.field];
        out = field === null || field === undefined ? null : Number(field);
      } else if (node.op === "constant") out = node.value;
      else if (node.op === "parameter") out = params[node.parameter] ?? null;
      else if (node.op === "shift") out = value(node.input, i - resolve(node.bars));
      else if ("window" in node) {
        const size = resolve(node.window);
        if (i >= size - 1) {
          const numbers: Array<number> = [];
          for (let j = i - size + 1; j <= i; j++) {
            const v = value(node.input, j);
            if (v !== null) numbers.push(v);
          }
          if (numbers.length === size) {
            const sum = numbers.reduce((a, b) => a + b, 0),
              mean = sum / size;
            switch (node.op) {
              case "rolling_min":
                out = Math.min(...numbers);
                break;
              case "rolling_max":
                out = Math.max(...numbers);
                break;
              case "rolling_sum":
                out = sum;
                break;
              case "rolling_mean":
                out = mean;
                break;
              case "rolling_std":
                out = Math.sqrt(numbers.reduce((a, b) => a + (b - mean) ** 2, 0) / size);
                break;
            }
          }
        }
      } else if ("left" in node) {
        const left = resolve(node.left),
          right = resolve(node.right),
          anchor = i - right,
          center = value(node.input, anchor);
        if (anchor >= left && center !== null && candles[i]?.complete) {
          let valid = true,
            minimum = Infinity,
            maximum = -Infinity;
          for (let j = anchor - left; j <= i; j++) {
            const v = value(node.input, j);
            if (v === null) {
              valid = false;
              break;
            }
            minimum = Math.min(minimum, v);
            maximum = Math.max(maximum, v);
            if (j !== anchor && (node.op === "swing_high" ? v >= center : v <= center))
              valid = false;
          }
          if (
            valid &&
            (node.op === "swing_high" ? center - minimum : maximum - center) >= node.minimumMove
          )
            out = center;
        }
      } else if (node.op === "if") {
        const condition = value(node.condition, i);
        out =
          condition === null ? null : value(condition !== 0 ? node.whenTrue : node.whenFalse, i);
      } else if ("a" in node) {
        const a = value(node.a, i),
          b = value(node.b, i);
        if (a !== null && b !== null) {
          switch (node.op) {
            case "add":
              out = a + b;
              break;
            case "subtract":
              out = a - b;
              break;
            case "multiply":
              out = a * b;
              break;
            case "divide":
              out = b === 0 ? null : a / b;
              break;
            case "min":
              out = Math.min(a, b);
              break;
            case "max":
              out = Math.max(a, b);
              break;
            case "gt":
              out = Number(a > b);
              break;
            case "gte":
              out = Number(a >= b);
              break;
            case "lt":
              out = Number(a < b);
              break;
            case "lte":
              out = Number(a <= b);
              break;
            case "equal":
              out = Number(a === b);
              break;
            case "and":
              out = Number(a !== 0 && b !== 0);
              break;
            case "or":
              out = Number(a !== 0 || b !== 0);
              break;
            case "cross_above":
            case "cross_below": {
              const pa = value(node.a, i - 1),
                pb = value(node.b, i - 1);
              out =
                pa === null || pb === null
                  ? null
                  : Number(node.op === "cross_above" ? pa <= pb && a > b : pa >= pb && a < b);
              break;
            }
          }
        }
      }
      rows.push(bounded(out));
    }
    series.set(node.id, rows);
  }
  return {
    parameters: params,
    times: candles.map((c) => c.openTime),
    outputs: definition.outputs.map((out) => ({
      id: out.id,
      type: out.type,
      pane: out.pane,
      values: series.get(out.node) ?? [],
      anchorTimes: candles.map((c, index) => {
        if (series.get(out.node)?.[index] == null) return null;
        const node = definition.nodes.find((n) => n.id === out.node);
        return node && "right" in node
          ? (candles[index - resolve(node.right)]?.openTime ?? null)
          : c.openTime;
      }),
    })),
  };
}
