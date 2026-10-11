import { describe, expect, it } from "vitest";
import { brokerReadFailure, presentBrokerRead } from "./broker-directory.js";
import { BrokerProviderError } from "./metaapi-normalize.js";

describe("broker read presentation", () => {
  it("does not send the persisted directory to the model", () => {
    const presented = presentBrokerRead({ operation: "instruments", accountId: "account" }, [
      {
        id: "1",
        accountId: "account",
        brokerSymbol: "EURUSDm",
        displayName: "Euro",
        verifiedAt: null,
      },
      {
        id: "2",
        accountId: "account",
        brokerSymbol: "BTCUSDTm",
        displayName: "Bitcoin",
        verifiedAt: null,
      },
    ]);
    expect(presented).toMatchObject({ accountId: "account", count: 2 });
    expect(JSON.stringify(presented)).not.toContain("EURUSDm");
    expect(JSON.stringify(presented)).not.toContain("BTCUSDTm");
  });

  it("labels broker candles and keeps a quote's exact symbol", () => {
    expect(
      presentBrokerRead({ operation: "candles", accountId: "account", instrumentId: "inst" }, [
        { time: "2026-10-11T00:00:00.000Z" },
      ]),
    ).toMatchObject({
      candles: [{ time: "2026-10-11T00:00:00.000Z" }],
      provenance: { source: "broker", instrumentId: "inst", supplementary: false },
    });
    expect(
      presentBrokerRead(
        { operation: "quote", accountId: "account", instrumentId: "inst" },
        { provider: "metaapi", accountId: "account", brokerSymbol: "USOIL", bid: "1" },
      ),
    ).toMatchObject({
      brokerSymbol: "USOIL",
      provenance: { source: "broker", provider: "metaapi", brokerSymbol: "USOIL" },
    });
  });

  it("distinguishes an invalid request from a temporary broker failure", () => {
    expect(brokerReadFailure(new BrokerProviderError("INVALID_REQUEST")).code).toBe(
      "INVALID_REQUEST",
    );
    expect(brokerReadFailure(new BrokerProviderError("TIMEOUT"))).toMatchObject({
      code: "TIMEOUT",
      substituteVenue: false,
    });
    expect(brokerReadFailure(new BrokerProviderError("DISCONNECTED")).guidance).toContain(
      "disconnected",
    );
    expect(JSON.stringify(brokerReadFailure(new Error("token-sentinel")))).not.toContain(
      "token-sentinel",
    );
  });
});
