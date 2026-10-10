import type { TradingAccountAccessView } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeSwitch } from "./native-switch";

export function TradingAccountAccess({ botId }: { botId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [rows, setRows] = useState<TradingAccountAccessView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setLoaded(false);
    void rpc<TradingAccountAccessView[]>("trading/accountAccess", { botId })
      .then((next) => {
        if (active) setRows(next);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [botId]);
  async function change(row: TradingAccountAccessView, accountRead: boolean) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await rpc("trading/setAccountAccess", {
        botId,
        accountId: row.accountId,
        accountRead,
        expectedRevision: row.revision,
      });
      setRows(await rpc<TradingAccountAccessView[]>("trading/accountAccess", { botId }));
    } catch (failure) {
      setError(errorText(failure));
      await rpc<TradingAccountAccessView[]>("trading/accountAccess", { botId })
        .then(setRows)
        .catch(() => setRows([]));
    } finally {
      setBusy(false);
    }
  }
  const muted = { color: tokens.mutedForeground, fontSize: 12 };
  return (
    <View style={{ marginTop: 16, gap: 12 }}>
      <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{t("Broker access")}</Text>
      {loaded && rows.length === 0 ? (
        <Text style={muted}>{t("No broker account is connected.")}</Text>
      ) : null}
      {rows.map((row) => {
        const readable = row.accountRead || row.mandateRead;
        return (
          <View key={row.accountId} style={{ gap: 4 }}>
            <Text style={muted}>{t("Account")}</Text>
            <Text style={{ color: tokens.foreground }}>{row.label}</Text>
            <Text style={muted}>
              {t("Market data")}: {t("Available")}
            </Text>
            <Text style={muted}>
              {t("Account balance / equity / margin / positions")}:{" "}
              {readable ? t("Allowed") : t("Not allowed")}
            </Text>
            <Text style={muted}>
              {t("Execution")}: {row.mandateRead ? t("Mandate scope") : t("No authority")}
            </Text>
            <NativeSwitch
              accessibilityLabel={`${row.label}: ${t("Allow account read")}`}
              value={row.accountRead}
              disabled={busy}
              onValueChange={(value) => void change(row, value)}
            />
          </View>
        );
      })}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
