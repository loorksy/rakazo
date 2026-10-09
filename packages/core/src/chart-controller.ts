import type { ChartCommand, ChartDrawing, CloudChartState } from "@rakazo/contracts";
import { CloudChartStateSchema } from "@rakazo/contracts";

export const CHART_DRAWING_CAPABILITIES = [
  ["horizontalStraightLine", 1],
  ["verticalStraightLine", 1],
  ["segment", 2],
  ["rayLine", 2],
  ["straightLine", 2],
  ["priceLine", 1],
  ["priceChannelLine", 3],
  ["parallelStraightLine", 3],
  ["rect", 2],
  ["triangle", 3],
  ["fibonacciLine", 2],
  ["fibonacciSegment", 2],
  ["simpleAnnotation", 1],
  ["simpleTag", 1],
] as const;
export class ChartConflictError extends Error {
  constructor() {
    super("Chart changed; reload the current state before editing");
  }
}
export class ChartPermissionError extends Error {
  constructor() {
    super("This chart object is not editable by this actor");
  }
}
export function timeframeMillis(timeframe: string, at: Date): number {
  if (timeframe === "1mn") {
    const next = new Date(at);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next.getTime() - at.getTime();
  }
  const match = /^(\d+)(m|h|d|w)$/.exec(timeframe);
  if (!match) throw new Error("Unsupported timeframe");
  const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2] ?? ""];
  if (!unit) throw new Error("Unsupported timeframe");
  return Number(match[1]) * unit;
}
/** Pure semantic navigation; numeric prices never pass through Number. */
export function changeChartState(input: {
  state: CloudChartState;
  revision: number;
  instrumentId: string;
  command: ChartCommand;
  actor: { id: string; user: boolean; responsibilityId?: string };
  now: Date;
  newId: string;
}): CloudChartState {
  const state = CloudChartStateSchema.parse(input.state);
  const cmd = input.command;
  if ("expectedRevision" in cmd && cmd.expectedRevision !== input.revision)
    throw new ChartConflictError();
  const at = input.now.toISOString();
  const duration = timeframeMillis(state.timeframe, input.now);
  switch (cmd.operation) {
    case "set_timeframe":
      state.timeframe = cmd.timeframe;
      break;
    case "set_viewport":
      state.viewport = cmd.viewport;
      break;
    case "zoom":
      state.viewport.candleCount = Math.max(
        10,
        Math.min(1000, Math.round(state.viewport.candleCount / cmd.factor)),
      );
      if (state.viewport.to)
        state.viewport.from = new Date(
          Date.parse(state.viewport.to) - duration * state.viewport.candleCount,
        ).toISOString();
      break;
    case "jump": {
      const end = Date.parse(cmd.time) + duration;
      state.viewport.to = new Date(end).toISOString();
      state.viewport.from = new Date(end - duration * state.viewport.candleCount).toISOString();
      break;
    }
    case "pan": {
      const end = Date.parse(state.viewport.to ?? at) + duration * cmd.candles;
      state.viewport.to = new Date(end).toISOString();
      state.viewport.from = new Date(end - duration * state.viewport.candleCount).toISOString();
      break;
    }
    case "reset_view":
      state.viewport = { from: null, to: null, candleCount: 200, rightSpacing: 40 };
      break;
    case "set_instrument":
      break;
    case "indicator_add":
      state.indicators.push({
        ...cmd.indicator,
        id: input.newId,
        revision: 1,
        creator: input.actor.user ? "USER" : "BOT",
        creatorId: input.actor.id,
        createdAt: at,
        updatedAt: at,
      });
      break;
    case "indicator_update":
    case "indicator_remove": {
      const index = state.indicators.findIndex((row) => row.id === cmd.indicatorId),
        previous = state.indicators[index];
      if (!previous) throw new Error("Indicator not found");
      if (previous.revision !== cmd.expectedIndicatorRevision) throw new ChartConflictError();
      if (
        !input.actor.user &&
        (previous.creator !== "BOT" || previous.creatorId !== input.actor.id)
      )
        throw new ChartPermissionError();
      if (cmd.operation === "indicator_remove") state.indicators.splice(index, 1);
      else
        state.indicators[index] = {
          ...previous,
          ...cmd.indicator,
          revision: previous.revision + 1,
          updatedAt: at,
        };
      break;
    }
    case "drawing_create": {
      const capability = CHART_DRAWING_CAPABILITIES.find(([id]) => id === cmd.drawing.type);
      if (!capability || cmd.drawing.points.length !== capability[1])
        throw new Error("Invalid drawing anchor count");
      state.drawings.push({
        ...cmd.drawing,
        id: input.newId,
        instrumentId: input.instrumentId,
        revision: 1,
        creator: input.actor.user ? "USER" : "BOT",
        creatorId: input.actor.id,
        responsibilityId: input.actor.responsibilityId ?? null,
        createdAt: at,
        updatedAt: at,
      });
      break;
    }
    case "drawing_update":
    case "drawing_delete": {
      const index = state.drawings.findIndex((row) => row.id === cmd.drawingId);
      const previous = state.drawings[index];
      if (!previous) throw new Error("Drawing not found");
      if (previous.revision !== cmd.expectedDrawingRevision) throw new ChartConflictError();
      if (
        !input.actor.user &&
        (previous.creator !== "BOT" || previous.creatorId !== input.actor.id || previous.locked)
      )
        throw new ChartPermissionError();
      if (cmd.operation === "drawing_delete") state.drawings.splice(index, 1);
      else {
        const capability = CHART_DRAWING_CAPABILITIES.find(([id]) => id === cmd.drawing.type);
        if (!capability || cmd.drawing.points.length !== capability[1])
          throw new Error("Invalid drawing anchor count");
        const next: ChartDrawing = {
          ...previous,
          ...cmd.drawing,
          revision: previous.revision + 1,
          updatedAt: at,
        };
        state.drawings[index] = next;
      }
      break;
    }
    default:
      throw new Error("Not a chart mutation");
  }
  return CloudChartStateSchema.parse(state);
}
