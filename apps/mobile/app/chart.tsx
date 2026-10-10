import type {
  BrokerInstrumentDirectory,
  ChartCommand,
  ChartRenderResponse,
  CloudChart,
  TradingConnectionView,
} from "@rakazo/contracts";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

/** Contextual native chart surface. The trusted backend renders it; no browser or Computer is involved. */
export default function ChartScreen() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [charts, setCharts] = useState<CloudChart[]>([]);
  const [accounts, setAccounts] = useState<TradingConnectionView[]>([]);
  const [accountId, setAccountId] = useState("");
  const [instruments, setInstruments] = useState<BrokerInstrumentDirectory>([]);
  const [query, setQuery] = useState("");
  const [chart, setChart] = useState<CloudChart | null>(null);
  const [image, setImage] = useState<ChartRenderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const focused = useRef(false);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const current = ++generation.current;
      void Promise.all([
        rpc<CloudChart[]>("trading/charts", { operation: "list" }),
        rpc<TradingConnectionView[]>("trading/connections/list"),
      ])
        .then(([saved, connected]) => {
          if (!focused.current || generation.current !== current) return;
          setCharts(
            saved.filter((row) => !botId || row.ownerBotId === botId || row.scope === "SHARED"),
          );
          setAccounts(connected.filter((a) => !a.revokedAt));
        })
        .catch((failure) => {
          if (focused.current) setError(errorText(failure));
        });
      return () => {
        focused.current = false;
        generation.current += 1;
      };
    }, [botId]),
  );

  async function display(next: CloudChart) {
    const current = ++generation.current;
    setChart(next);
    setImage(null);
    const rendered = await rpc<ChartRenderResponse>(
      "trading/chartRender",
      { chartId: next.id },
      { timeoutMs: 30000 },
    );
    if (focused.current && generation.current === current) setImage(rendered);
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (focused.current) setError(errorText(failure));
    } finally {
      if (focused.current) setBusy(false);
    }
  }
  async function change(command: ChartCommand) {
    await perform(async () => {
      const next = await rpc<CloudChart>("trading/charts", command);
      await display(next);
    });
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={styles.row}>
        {charts.map((saved) => (
          <NativeActionButton
            key={saved.id}
            label={`${saved.brokerSymbol} · ${saved.state.timeframe}`}
            prominence="quiet"
            disabled={busy}
            selected={saved.id === chart?.id}
            onPress={() => void perform(() => display(saved))}
          />
        ))}
      </View>
      {chart ? (
        <>
          <View style={styles.row}>
            {(["1m", "15m", "1h", "4h", "1d"] as const).map((timeframe) => (
              <NativeActionButton
                key={timeframe}
                label={timeframe}
                selected={chart.state.timeframe === timeframe}
                disabled={busy}
                prominence="quiet"
                onPress={() =>
                  void change({
                    operation: "set_timeframe",
                    chartId: chart.id,
                    expectedRevision: chart.revision,
                    timeframe,
                  })
                }
              />
            ))}
          </View>
          <View style={styles.row}>
            <NativeActionButton
              label={t("Zoom in")}
              disabled={busy}
              prominence="quiet"
              onPress={() =>
                void change({
                  operation: "zoom",
                  chartId: chart.id,
                  expectedRevision: chart.revision,
                  factor: 2,
                })
              }
            />
            <NativeActionButton
              label={t("Zoom out")}
              disabled={busy}
              prominence="quiet"
              onPress={() =>
                void change({
                  operation: "zoom",
                  chartId: chart.id,
                  expectedRevision: chart.revision,
                  factor: 0.5,
                })
              }
            />
            <NativeActionButton
              label={t("Refresh")}
              busy={busy}
              prominence="quiet"
              onPress={() =>
                void perform(async () =>
                  display(
                    await rpc<CloudChart>("trading/charts", {
                      operation: "get",
                      chartId: chart.id,
                    }),
                  ),
                )
              }
            />
          </View>
          {image ? (
            <Image
              accessibilityLabel={`${chart.brokerSymbol} ${chart.state.timeframe}`}
              source={{ uri: `data:image/png;base64,${image.data}` }}
              resizeMode="contain"
              style={[styles.image, { aspectRatio: image.metadata.width / image.metadata.height }]}
            />
          ) : (
            <Text style={styles.muted}>{t("Loading…")}</Text>
          )}
        </>
      ) : null}
      <View style={styles.row}>
        {accounts.map((account) => (
          <NativeActionButton
            key={account.id}
            label={account.label}
            prominence="quiet"
            disabled={busy}
            selected={account.id === accountId}
            onPress={() =>
              void perform(async () => {
                setAccountId(account.id);
                setInstruments([]);
                setInstruments(
                  await rpc<BrokerInstrumentDirectory>("trading/read", {
                    operation: "instruments",
                    accountId: account.id,
                  }),
                );
              })
            }
          />
        ))}
      </View>
      {accountId ? (
        <>
          <TextInput
            accessibilityLabel={t("Search symbols")}
            placeholder={t("Search symbols")}
            placeholderTextColor={mobileTokens().mutedForeground}
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
          />
          {instruments
            .filter((symbol) =>
              `${symbol.brokerSymbol} ${symbol.displayName}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .slice(0, 20)
            .map((symbol) => (
              <NativeActionButton
                key={symbol.id}
                label={symbol.brokerSymbol}
                prominence="quiet"
                disabled={busy}
                onPress={() =>
                  void perform(async () => {
                    const existing = charts.find(
                      (c) => c.accountId === accountId && c.instrumentId === symbol.id,
                    );
                    const next =
                      existing ??
                      (await rpc<CloudChart>("trading/charts", {
                        operation: "create",
                        accountId,
                        instrumentId: symbol.id,
                        timeframe: "1h",
                        scope: botId ? "WORKER" : "PRIVATE",
                        ...(botId ? { botId } : {}),
                      }));
                    setCharts((saved) =>
                      saved.some((c) => c.id === next.id) ? saved : [...saved, next],
                    );
                    await display(next);
                  })
                }
              />
            ))}
        </>
      ) : null}
    </ScrollView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    page: { padding: 16, gap: 12, backgroundColor: tokens.background, flexGrow: 1 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    image: { width: "100%" },
    muted: { color: tokens.mutedForeground },
    error: { color: tokens.destructive },
    input: {
      padding: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 12,
      color: tokens.foreground,
    },
  });
}
