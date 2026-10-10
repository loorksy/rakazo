import type { TradingConnectionView } from "@rakazo/contracts";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { TradingJournal } from "./trading-journal";

export function TradingConnections() {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<TradingConnectionView[]>([]);
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState("");
  const [token, setToken] = useState("");
  const [region, setRegion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    setAccounts(await rpc<TradingConnectionView[]>("trading/connections/list"));
  }
  async function toggle() {
    setOpen(!open);
    if (!open) {
      try {
        await refresh();
      } catch (failure) {
        setError(errorText(failure));
      }
    }
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc(
        "trading/connections/save",
        { label, providerAccountId: account, token, region: region || undefined },
        { timeoutMs: 30000 },
      );
      setToken("");
      setAccount("");
      setLabel("");
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(accountId: string) {
    setBusy(true);
    setError(null);
    try {
      await rpc("trading/connections/revoke", { accountId });
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={styles.panel}>
      <NativeActionButton label={t("Broker accounts")} onPress={() => void toggle()} />
      {open ? (
        <View style={styles.content}>
          {accounts
            .filter((row) => !row.revokedAt)
            .map((row) => (
              <View key={row.id}>
                <Text style={styles.label}>
                  {row.label} · {row.state} {row.environment ?? ""}
                </Text>
                <NativeActionButton
                  label={t("Disconnect")}
                  disabled={busy}
                  onPress={() => void revoke(row.id)}
                />
              </View>
            ))}
          <TradingJournal />
          <TextInput
            style={styles.input}
            placeholder={t("Account name")}
            accessibilityLabel={t("Account name")}
            value={label}
            onChangeText={setLabel}
            maxLength={80}
          />
          <TextInput
            style={styles.input}
            placeholder={t("MetaApi account ID")}
            accessibilityLabel={t("MetaApi account ID")}
            value={account}
            onChangeText={setAccount}
            autoCapitalize="none"
            maxLength={128}
          />
          <TextInput
            style={styles.input}
            placeholder={t("Region (optional)")}
            accessibilityLabel={t("Region (optional)")}
            value={region}
            onChangeText={setRegion}
            autoCapitalize="none"
            maxLength={32}
          />
          <TextInput
            style={styles.input}
            placeholder={t("API token")}
            accessibilityLabel={t("API token")}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <NativeActionButton
            label={t("Connect account")}
            disabled={busy || !label || !account || !token}
            onPress={() => void save()}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    panel: { marginVertical: 12 },
    content: { gap: 12, marginTop: 12 },
    label: { color: tokens.foreground, fontSize: 14 },
    input: {
      color: tokens.foreground,
      backgroundColor: tokens.card,
      borderColor: tokens.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 8,
      padding: 12,
    },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
