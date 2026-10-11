import { MessageBlock, type TradingCard, TradingPresentationSchema } from "@rakazo/contracts";
import { assumesAccountBalance, type PinnedMarket } from "@rakazo/core";

function cardMarket(card: TradingCard): { instrumentId: string; brokerSymbol: string } | null {
  if ("market" in card && card.market) return card.market;
  return null;
}

/** Cards are validated data. They do not create execution authority. */
export function tradingPresentationBlocks(
  raw: unknown,
  pin: PinnedMarket | null,
  accountRead: boolean,
): { blocks: MessageBlock[] } | { error: string } {
  const parsed = TradingPresentationSchema.safeParse(raw);
  if (!parsed.success)
    return { error: "Present one short answer and at most three trading cards." };
  if (
    assumesAccountBalance(parsed.data.text) ||
    assumesAccountBalance(JSON.stringify(parsed.data.cards))
  )
    return {
      error: "Do not assume an account balance. Position size is unavailable without account read.",
    };
  for (const card of parsed.data.cards) {
    const market = cardMarket(card);
    if (!market) continue;
    if (!pin) return { error: "Pin the broker instrument before presenting a market card." };
    if (market.instrumentId !== pin.instrumentId || market.brokerSymbol !== pin.brokerSymbol)
      return { error: `Cards must use the pinned instrument ${pin.brokerSymbol}.` };
    if ("positionSize" in card && card.positionSize !== null && !accountRead)
      return { error: "Position size is unavailable without account read." };
  }
  return {
    blocks: MessageBlock.array().parse([
      { kind: "text", text: parsed.data.text },
      ...parsed.data.cards.map((card) => ({ kind: "trading_card", card })),
    ]),
  };
}
