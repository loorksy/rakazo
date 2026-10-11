import { MessageBlock, type TradingCard, TradingPresentationSchema } from "@rakazo/contracts";
import { assumesAccountBalance, type PinnedMarket } from "@rakazo/core";

function cardMarket(card: TradingCard): { instrumentId: string; brokerSymbol: string } | null {
  if ("market" in card && card.market) return card.market;
  return null;
}

function normalizePresentation(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw;
  const record = raw as { text?: unknown; cards?: unknown };
  const cards = Array.isArray(record.cards) ? record.cards.slice(0, 3) : [];
  return {
    text: String(record.text ?? "")
      .trim()
      .slice(0, 700),
    cards: cards.map((card) => {
      if (!card || typeof card !== "object") return card;
      const next = { ...(card as Record<string, unknown>) };
      if (next.type === "RECOMMENDATION") {
        next.currentPrice ??= null;
        next.entry ??= null;
        next.stopLoss ??= null;
        next.target ??= null;
        next.riskReward ??= null;
        next.status ??= "ACTIVE";
        next.freshness ??= "broker";
        next.positionSize ??= null;
        next.timeframe ??= "1h";
        if (typeof next.side === "string") next.side = next.side.toUpperCase();
      }
      if (next.market && typeof next.market === "object") {
        const market = { ...(next.market as Record<string, unknown>) };
        market.provider ??= "metaapi";
        next.market = market;
      }
      return next;
    }),
  };
}

/** Cards are validated data. They do not create execution authority. */
export function tradingPresentationBlocks(
  raw: unknown,
  pin: PinnedMarket | null,
  accountRead: boolean,
): { blocks: MessageBlock[] } | { error: string } {
  const parsed = TradingPresentationSchema.safeParse(normalizePresentation(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: `Card field ${issue?.path.join(".") || "cards"} is invalid. Use the pinned instrument and at most three cards.`,
    };
  }
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
