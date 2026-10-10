import type { TradingAccountAccessView } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function TradingAccountAccess({ botId }: { botId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TradingAccountAccessView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    setRows([]);
    void rpc<TradingAccountAccessView[]>("trading/accountAccess", { botId })
      .then((next) => {
        if (active) setRows(next);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [botId, open]);
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
  return (
    <View style={{ marginTop: 16, gap: 12 }}>
      <NativeActionButton label={t("Account access")} onPress={() => setOpen(!open)} />
      {open
        ? rows.map((row) => (
            <View
              key={row.accountId}
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.foreground }}>{row.label}</Text>
                {row.mandateRead ? (
                  <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                    {t("Read access through active mandate")}
                  </Text>
                ) : null}
              </View>
              <NativeSwitch
                accessibilityLabel={`${row.label}: ${t("Account read")}`}
                value={row.accountRead}
                disabled={busy}
                onValueChange={(value) => void change(row, value)}
              />
            </View>
          ))
        : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
