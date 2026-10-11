import { describe, expect, it } from "vitest";
import { tradingPresentationBlocks } from "./trading-presentation.js";

const market = {
  accountId: "account",
  instrumentId: "btc",
  brokerSymbol: "BTCUSDTm",
  provider: "metaapi",
};

describe("trading presentation", () => {
  it("publishes a short answer and a recommendation card for the pinned instrument", () => {
    const result = tradingPresentationBlocks(
      {
        text: "BTCUSDTm is mid-range, so the plan is to wait.",
        cards: [
          {
            type: "RECOMMENDATION",
            market,
            side: "WAIT",
            timeframe: "1h",
            currentPrice: "82950",
            entry: "82000",
            stopLoss: "81200",
            target: "85500",
            riskReward: "1:2.4",
            status: "WAITING_ENTRY",
            freshness: "live",
            positionSize: null,
          },
        ],
      },
      { ...market },
      false,
    );
    expect("blocks" in result).toBe(true);
    if (!("blocks" in result)) return;
    expect(result.blocks[0]).toMatchObject({ kind: "text" });
    expect(result.blocks[1]).toMatchObject({
      kind: "trading_card",
      card: { type: "RECOMMENDATION", side: "WAIT", market: { brokerSymbol: "BTCUSDTm" } },
    });
    expect(JSON.stringify(result.blocks[0])).not.toContain("10000");
  });

  it("rejects another symbol and an assumed balance", () => {
    expect(
      tradingPresentationBlocks(
        {
          text: "Using a 10000 balance.",
          cards: [],
        },
        { ...market },
        false,
      ),
    ).toMatchObject({ error: expect.stringContaining("account balance") });
    expect(
      tradingPresentationBlocks(
        {
          text: "Another market.",
          cards: [
            {
              type: "CHART",
              market: { ...market, instrumentId: "other", brokerSymbol: "BTCUSDm" },
              timeframe: "1h",
            },
          ],
        },
        { ...market },
        false,
      ),
    ).toMatchObject({ error: expect.stringContaining("BTCUSDTm") });
  });
});
