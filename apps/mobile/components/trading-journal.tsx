import type { TradingJournalPage } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

export function TradingJournal({ mandateId }: { mandateId?: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<TradingJournalPage>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    setPage(undefined);
    setError(undefined);
    void rpc<TradingJournalPage>("trading/journal", { mandateId, limit: 30 })
      .then((next) => {
        if (active) setPage(next);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [mandateId, open]);
  async function more() {
    if (busy || !page?.nextCursor) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await rpc<TradingJournalPage>("trading/journal", {
        mandateId,
        cursor: page.nextCursor,
        limit: 30,
      });
      setPage({ entries: [...page.entries, ...next.entries], nextCursor: next.nextCursor });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ marginTop: 12, gap: 12 }}>
      <NativeActionButton label={t("Journal")} onPress={() => setOpen(!open)} />
      {open ? (
        <View style={{ gap: 12 }}>
          {page?.entries.map((entry) => (
            <View key={entry.id}>
              <NativeActionButton
                label={`${entry.event.replaceAll("_", " ")} · ${entry.mode} · ${new Date(entry.createdAt).toLocaleString()}`}
                onPress={() => setSelected(selected === entry.id ? undefined : entry.id)}
              />
              {selected === entry.id ? (
                <Text selectable style={{ color: tokens.foreground, fontSize: 12 }}>
                  {JSON.stringify(entry.entry, null, 2)}
                </Text>
              ) : null}
            </View>
          ))}
          {page && !page.entries.length ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("No financial events")}</Text>
          ) : null}
          {page?.nextCursor ? (
            <NativeActionButton
              label={t("Load more")}
              disabled={busy}
              onPress={() => void more()}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
