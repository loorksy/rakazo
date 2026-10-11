import { describe, expect, it } from "vitest";
import {
  assumesAccountBalance,
  executionFingerprint,
  marketPinDecision,
  previewProtection,
} from "./trading-run-market.js";

const btc = { accountId: "a", instrumentId: "usdt", brokerSymbol: "BTCUSDTm", provider: "metaapi" };

describe("pinned broker instrument", () => {
  it("keeps the first instrument and rejects a silent switch", () => {
    expect(marketPinDecision(null, btc, false).action).toBe("pin");
    expect(
      marketPinDecision(btc, { ...btc, instrumentId: "usd", brokerSymbol: "BTCUSDm" }, false),
    ).toMatchObject({ action: "deny" });
    expect(
      marketPinDecision(btc, { ...btc, instrumentId: "usd", brokerSymbol: "BTCUSDm" }, true),
    ).toEqual({ action: "allow", supplementary: true });
  });

  it("does not start a comparison before a primary exists", () => {
    expect(marketPinDecision(null, btc, true).action).toBe("deny");
  });

  it("changes the execution fingerprint when the lot changes", () => {
    const first = executionFingerprint(["usdt", "BUY", "0.10"]);
    const second = executionFingerprint(["usdt", "BUY", "0.20"]);
    expect(first).not.toBe(second);
  });

  it("calculates protection from the contract size and refuses an assumed balance", () => {
    expect(
      previewProtection({
        side: "BUY",
        entry: "100",
        stop: "90",
        target: "120",
        volume: "1",
        contractSize: "1",
      }),
    ).toEqual({ loss: "10", profit: "20" });
    expect(
      previewProtection({
        ...{
          side: "BUY" as const,
          entry: "100",
          stop: "90",
          target: "120",
          volume: "1",
          contractSize: null,
        },
      }),
    ).toEqual({ loss: null, profit: null });
    expect(assumesAccountBalance("balance 10000")).toBe(true);
    expect(assumesAccountBalance("BTCUSDTm is mid-range")).toBe(false);
  });
});
