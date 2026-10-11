import type { TradingCard } from "@rakazo/contracts";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

function symbolOf(card: TradingCard) {
  return "market" in card && card.market ? card.market.brokerSymbol : null;
}

export function MobileTradingCard({ card }: { card: TradingCard }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const symbol = symbolOf(card);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        borderRadius: 16,
        padding: 14,
        gap: 6,
      }}
    >
      {symbol ? (
        <Text style={{ color: tokens.foreground, fontWeight: "700", writingDirection: "ltr" }}>
          {symbol}
        </Text>
      ) : null}
      {card.type === "RECOMMENDATION" ? (
        <Text style={{ color: tokens.foreground }}>
          {card.side} · {card.timeframe}
        </Text>
      ) : null}
      <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
        {card.type === "REPORT" ? t("View report") : card.type.replaceAll("_", " ")}
      </Text>
      {card.type === "RECOMMENDATION" ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {t("Position size is unavailable without account read.")}
        </Text>
      ) : null}
    </View>
  );
}
