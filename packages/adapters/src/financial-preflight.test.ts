import type { BrokerReadCommand, FinancialAction, SimulationBookState } from "@rakazo/contracts";
import { FinancialRiskFactsSchema, SimulationBookStateSchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartActor } from "./cloud-charts.js";
import { financialPreflight } from "./financial-preflight.js";
import { SimulationBroker } from "./simulation-broker.js";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./trading-connections.js", () => ({ requestBrokerRead: read }));
const time = "2026-10-09T10:00:00Z";
const actor: ChartActor = {
  ownerUserId: "owner",
  botId: "main",
  execution: { runId: "run", holder: "worker", generation: 1 },
};
const open: FinancialAction = {
  version: 1,
  mode: "SIMULATION",
  provider: "metaapi",
  accountId: "account",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  operation: "OPEN",
  side: "BUY",
  orderType: "MARKET",
  volume: "0.01",
  price: null,
  stopLimitPrice: null,
  expiresAt: null,
  fillingMode: null,
  stopLoss: "2695",
  takeProfit: "2710",
};
const facts = FinancialRiskFactsSchema.parse({
  version: 1,
  accountId: "account",
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  currency: "USD",
  connected: true,
  tradingAllowed: true,
  accountMode: "HEDGING",
  observedAt: time,
  equity: "10000",
  freeMargin: "9500",
  margin: "500",
  tickSize: "0.01",
  lossTickValue: "1",
  contractSize: "100",
  profitCurrency: "USD",
  minVolume: "0.01",
  maxVolume: "100",
  volumeStep: "0.01",
  digits: 2,
  stopsLevel: 10,
  symbolTradingAllowed: true,
  specificationObservedAt: time,
  orderTypes: ["MARKET", "LIMIT"],
  partialClose: true,
  proposedMargin: "30",
  openPositions: [],
  pendingOrders: [],
  quote: {
    version: 1,
    provider: "metaapi",
    accountId: "account",
    instrumentId: "gold",
    brokerSymbol: "GOLD.a",
    bid: "2700",
    ask: "2700.1",
    sourceTime: time,
    receivedAt: time,
    revision: "q",
  },
});
const empty: SimulationBookState = {
  version: 1,
  mode: "SIMULATION",
  accountId: "account",
  currency: "USD",
  initialEquity: "10000",
  balance: "10000",
  positions: [],
  orders: [],
  performance: [],
};
const exposure = {
  id: "sim_original",
  originEffectId: "original",
  mandateId: "mandate",
  goalId: "goal",
  planVersion: 1,
  instrumentId: "gold",
  brokerSymbol: "GOLD.a",
  side: "BUY" as const,
  volume: "0.01",
  entry: "2699",
  stopLoss: "2695",
  takeProfit: "2710",
  contractSize: "100",
  margin: "30",
  createdAt: time,
  updatedAt: time,
};

/** Prisma is fully typed; every external operation is spied, so no server/network is contacted. */
function fixture(state: SimulationBookState | null = null) {
  const db = createDb(
    "postgresql://fixture:fixture-only-not-a-secret@127.0.0.1:1/unconnected_test",
  );
  vi.spyOn(db.prisma.simulationBook, "findFirst").mockResolvedValue(
    state
      ? {
          accountId: "account",
          ownerUserId: "owner",
          formatVersion: 1,
          revision: 3,
          state,
          nextExpiryAt: null,
          createdAt: new Date(time),
          updatedAt: new Date(time),
        }
      : null,
  );
  const projection = vi
    .spyOn(SimulationBroker.prototype, "preflight")
    .mockResolvedValue({ ...facts, simulationRevision: 3 });
  read.mockResolvedValue(facts);
  return {
    db,
    projection,
    close: async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  read.mockReset();
});

describe("trusted financial preflight composition", () => {
  it("bridges a synthetic pending-order change into broker margin evidence without sending a fake broker order ID", async () => {
    const f = fixture({
      ...empty,
      orders: [{ ...exposure, orderType: "LIMIT", expiresAt: "2026-10-09T20:00:00Z" }],
    });
    try {
      const action: FinancialAction = {
        version: 1,
        mode: "SIMULATION",
        provider: "metaapi",
        accountId: "account",
        instrumentId: "gold",
        brokerSymbol: "GOLD.a",
        operation: "MODIFY_ORDER",
        orderId: "sim_original",
        price: "2698",
        volume: "0.02",
        stopLoss: "2695",
        takeProfit: "2710",
        expiresAt: "2026-10-09T18:00:00Z",
        stopLimitPrice: null,
      };
      expect(await financialPreflight(f.db.prisma, actor, action)).toMatchObject({
        simulationRevision: 3,
      });
      const request = read.mock.calls[0]?.[2];
      expect(request).toMatchObject({
        operation: "preflight",
        action: {
          operation: "OPEN",
          orderType: "LIMIT",
          side: "BUY",
          price: "2698",
          volume: "0.02",
        },
      });
      expect(JSON.stringify(request)).not.toContain("sim_original");
      expect(f.projection).toHaveBeenCalledWith(actor, facts, []);
    } finally {
      await f.close();
    }
  });
  it("coalesces repeated instruments and fetches other open quotes with at most four concurrent reads", async () => {
    const state = SimulationBookStateSchema.parse({
      ...empty,
      positions: Array.from({ length: 10 }, (_, index) => ({
        ...exposure,
        id: `position-${index}`,
        originEffectId: `effect-${index}`,
        instrumentId: `instrument-${Math.floor(index / 2)}`,
        brokerSymbol: `SYMBOL${Math.floor(index / 2)}`,
      })),
    });
    const f = fixture(state);
    let active = 0,
      peak = 0;
    read.mockImplementation(async (_db: unknown, _owner: string, request: BrokerReadCommand) => {
      if (request.operation === "preflight") return facts;
      if (request.operation !== "quote") throw new Error("Unexpected read");
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        ...facts.quote,
        instrumentId: request.instrumentId,
        brokerSymbol: `SYMBOL${request.instrumentId.split("-")[1]}`,
      };
    });
    try {
      await financialPreflight(f.db.prisma, actor, open);
      expect(peak).toBe(4);
      expect(read).toHaveBeenCalledTimes(6);
      expect(f.projection.mock.calls[0]?.[2]).toHaveLength(5);
    } finally {
      await f.close();
    }
  });
  it("does not seed virtual accounting for LIVE reads and does not mutate a provider", async () => {
    const f = fixture();
    try {
      expect(await financialPreflight(f.db.prisma, actor, { ...open, mode: "LIVE" })).toEqual(
        facts,
      );
      expect(f.projection).not.toHaveBeenCalled();
      expect(f.db.prisma.simulationBook.findFirst).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it("cancellation prevents provider reads and simulated accounting", async () => {
    const f = fixture();
    try {
      await expect(
        financialPreflight(f.db.prisma, actor, open, AbortSignal.abort()),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(f.projection).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
