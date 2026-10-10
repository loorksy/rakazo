import type { ExecutionRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MetaApiExecutionAdapter } from "./metaapi-execution.js";

const request: ExecutionRequest = {
  effectId: "fixture-effect",
  clientId: "rz_0123456789_abcdef0123",
  startedAt: "2026-10-10T12:00:00.000Z",
  action: {
    version: 1,
    mode: "LIVE",
    provider: "metaapi",
    accountId: "fixture-account",
    instrumentId: "fixture-instrument",
    brokerSymbol: "EURUSD",
    operation: "OPEN",
    side: "BUY",
    orderType: "MARKET",
    volume: "0.1",
    price: null,
    stopLimitPrice: null,
    stopLoss: "1.09",
    takeProfit: "1.12",
    expiresAt: null,
    fillingMode: null,
  },
};
function fixture() {
  const rpc = {
    getPositions: vi.fn(async () => [] as unknown[]),
    getOrders: vi.fn(async () => [] as unknown[]),
    createMarketBuyOrder: vi.fn(async () => ({
      numericCode: 10009,
      positionId: "fixture-position",
    })),
    modifyPosition: vi.fn(async () => ({ numericCode: 10009 })),
    closePosition: vi.fn(async () => ({ numericCode: 10009 })),
    closePositionPartially: vi.fn(async () => ({ numericCode: 10009 })),
    cancelOrder: vi.fn(async () => ({ numericCode: 10009 })),
  };
  return { rpc, adapter: new MetaApiExecutionAdapter("fixture-account", rpc) };
}
describe("trusted MetaApi execution boundary (fixtures only)", () => {
  it("sends exact decimal values and stable identity once without exposing provider diagnostics", async () => {
    const { rpc, adapter } = fixture();
    expect(await adapter.execute(request)).toEqual({
      status: "SUCCEEDED",
      providerReference: "fixture-position",
      code: "PROVIDER_ACKNOWLEDGED",
    });
    expect(rpc.createMarketBuyOrder).toHaveBeenCalledExactlyOnceWith("EURUSD", 0.1, 1.09, 1.12, {
      clientId: request.clientId,
    });
  });
  it.each([10004, 10006, 10014, 10016, 10018, 10019, 10021])(
    "normalizes explicit rejection %s",
    async (numericCode) => {
      const { rpc, adapter } = fixture();
      rpc.createMarketBuyOrder.mockResolvedValue({ numericCode, positionId: "fixture-position" });
      expect(await adapter.execute(request)).toMatchObject({
        status: "FAILED",
        code: `PROVIDER_REJECTED_${numericCode}`,
      });
    },
  );
  it.each([10010, 10012, 10031, 99999])(
    "does not retry ambiguous acknowledgement %s",
    async (numericCode) => {
      const { rpc, adapter } = fixture();
      rpc.createMarketBuyOrder.mockResolvedValue({ numericCode, positionId: "fixture-position" });
      expect(await adapter.execute(request)).toMatchObject({ status: "UNCERTAIN" });
      expect(rpc.createMarketBuyOrder).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps transport errors secret-free and uncertain", async () => {
    const { rpc, adapter } = fixture();
    rpc.createMarketBuyOrder.mockRejectedValue(new Error("sentinel-secret"));
    const outcome = await adapter.execute(request);
    expect(outcome.status).toBe("UNCERTAIN");
    expect(JSON.stringify(outcome)).not.toContain("sentinel-secret");
    expect(rpc.createMarketBuyOrder).toHaveBeenCalledTimes(1);
  });
  it("normalizes native SDK TradeError without forwarding its message", async () => {
    const { rpc, adapter } = fixture();
    rpc.createMarketBuyOrder.mockRejectedValue(
      Object.assign(new Error("sentinel-secret"), { numericCode: 10018 }),
    );
    expect(await adapter.execute(request)).toEqual({
      status: "FAILED",
      providerReference: null,
      code: "PROVIDER_REJECTED_10018",
    });
    expect(rpc.createMarketBuyOrder).toHaveBeenCalledTimes(1);
  });
  it("does not confirm an entry without a durable provider reference", async () => {
    const { rpc, adapter } = fixture();
    rpc.createMarketBuyOrder.mockResolvedValue({ numericCode: 10009, positionId: "" });
    expect(await adapter.execute(request)).toMatchObject({ status: "UNCERTAIN" });
  });
  it("reconciles a positively matched provider identity using reads only", async () => {
    const { rpc, adapter } = fixture();
    rpc.getPositions.mockResolvedValue([
      {
        id: "fixture-position",
        clientId: request.clientId,
        symbol: "EURUSD",
        type: "POSITION_TYPE_BUY",
        volume: 0.1,
      },
    ]);
    expect(await adapter.reconcile(request)).toMatchObject({
      status: "SUCCEEDED",
      providerReference: "fixture-position",
    });
    expect(rpc.createMarketBuyOrder).not.toHaveBeenCalled();
  });
  it.each([
    { positions: [] },
    {
      positions: [
        {
          id: "another-position",
          clientId: request.clientId,
          symbol: "OTHER",
          type: "POSITION_TYPE_BUY",
          volume: 0.1,
        },
      ],
    },
    {
      positions: [
        {
          id: "partial",
          clientId: request.clientId,
          symbol: "EURUSD",
          type: "POSITION_TYPE_BUY",
          volume: 0.05,
        },
      ],
    },
  ])("absence, mismatched identity and partial fills stay uncertain", async ({ positions }) => {
    const { rpc, adapter } = fixture();
    rpc.getPositions.mockResolvedValue(positions);
    expect(await adapter.reconcile(request)).toMatchObject({ status: "UNCERTAIN" });
    expect(rpc.createMarketBuyOrder).not.toHaveBeenCalled();
  });
  it("does not infer attribution from an absent management target", async () => {
    const { adapter } = fixture();
    expect(
      await adapter.reconcile({
        ...request,
        action: {
          version: 1,
          mode: "LIVE",
          provider: "metaapi",
          accountId: "fixture-account",
          instrumentId: "fixture-instrument",
          brokerSymbol: "EURUSD",
          operation: "CLOSE_POSITION",
          positionId: "fixture-position",
          volume: null,
        },
      }),
    ).toMatchObject({ status: "UNCERTAIN" });
  });
  it("rejects foreign accounts before invoking an SDK method", async () => {
    const { rpc, adapter } = fixture();
    await expect(
      adapter.execute({ ...request, action: { ...request.action, accountId: "other" } }),
    ).rejects.toThrow("identity");
    expect(rpc.createMarketBuyOrder).not.toHaveBeenCalled();
  });
  it("does not silently discard unsupported pending expiry", async () => {
    const { rpc, adapter } = fixture();
    expect(
      await adapter.execute({
        ...request,
        action: {
          ...request.action,
          operation: "OPEN",
          side: "BUY",
          orderType: "LIMIT",
          volume: "0.1",
          price: "1.1",
          stopLimitPrice: null,
          expiresAt: "2026-10-10T13:00:00.000Z",
          fillingMode: null,
          stopLoss: "1.09",
          takeProfit: null,
        },
      }),
    ).toMatchObject({ status: "FAILED", code: "CAPABILITY_UNAVAILABLE" });
    expect(rpc.createMarketBuyOrder).not.toHaveBeenCalled();
  });
  it("manages only the exact selected position and preserves null stops as explicit removal", async () => {
    const { rpc, adapter } = fixture();
    expect(
      await adapter.execute({
        ...request,
        action: {
          version: 1,
          mode: "LIVE",
          provider: "metaapi",
          accountId: "fixture-account",
          instrumentId: "fixture-instrument",
          brokerSymbol: "EURUSD",
          operation: "MODIFY_PROTECTION",
          positionId: "fixture-position",
          stopLoss: "1.1",
          takeProfit: null,
        },
      }),
    ).toMatchObject({ status: "SUCCEEDED" });
    expect(rpc.modifyPosition).toHaveBeenCalledExactlyOnceWith("fixture-position", 1.1, 0);
  });
});
