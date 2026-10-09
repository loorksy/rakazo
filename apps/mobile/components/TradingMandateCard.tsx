import type {
  AccountRiskGuardrails,
  TradingMandateView,
  TradingMissionDetail,
} from "@rakazo/contracts";
import {
  AccountRiskGuardrailsSchema,
  TradingMandateViewSchema,
  TradingMissionDetailSchema,
} from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { NativeActionButton } from "./native-action-button";

export function TradingMandateCard({ goalId, mandateId }: { goalId: string; mandateId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const readOnly = useThreadReadOnly();
  const [detail, setDetail] = useState<TradingMissionDetail>();
  const [mandate, setMandate] = useState<TradingMandateView>();
  const [guardrails, setGuardrails] = useState<AccountRiskGuardrails | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [risk, setRisk] = useState("");
  const [exposure, setExposure] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void rpc("trading/missions", { operation: "get", goalId }, { signal: abort.signal })
      .then(async (raw) => {
        const current = TradingMissionDetailSchema.parse(raw);
        const selected = current.mandates.find((row) => row.id === mandateId);
        if (!selected) throw new Error("Mandate unavailable");
        const rawLimits = await rpc(
          "trading/accountGuardrails",
          { accountId: selected.envelope.accountId, mode: selected.envelope.mode },
          { signal: abort.signal },
        );
        const limits = AccountRiskGuardrailsSchema.nullable().parse(rawLimits);
        if (abort.signal.aborted) return;
        setDetail(current);
        setMandate(selected);
        setGuardrails(limits);
        setRisk(limits?.maxReservedRisk ?? selected.envelope.maxMissionLoss);
        setExposure(limits?.maxExposure ?? selected.envelope.maxNotional);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [goalId, mandateId]);
  async function action(task: () => Promise<void>) {
    if (readOnly || busy) return;
    setBusy(true);
    setError(false);
    try {
      await task();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  if (!mandate || !detail)
    return (
      <Text style={{ color: tokens.mutedForeground }}>
        {error ? t("Mission unavailable") : t("Loading mission…")}
      </Text>
    );
  const envelope = mandate.envelope;
  function resolve(approve: boolean) {
    const current = mandate;
    if (!current) return;
    void action(async () =>
      setMandate(
        TradingMandateViewSchema.parse(
          await rpc("trading/resolveMandate", {
            id: current.id,
            expectedRevision: current.revision,
            fingerprint: current.fingerprint,
            approve,
          }),
        ),
      ),
    );
  }
  async function control(command: "PAUSE" | "CANCEL" | "EMERGENCY_STOP") {
    const current = mandate;
    if (!current) return;
    await action(async () =>
      setMandate(
        TradingMandateViewSchema.parse(
          await rpc("trading/controlMandate", {
            id: current.id,
            expectedRevision: current.revision,
            action: command,
          }),
        ),
      ),
    );
  }
  return (
    <View
      style={{
        backgroundColor: tokens.card,
        borderColor: tokens.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: 16,
        gap: 8,
      }}
    >
      <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
        {t("Trading mission")} · {envelope.mode} · {mandate.status}
      </Text>
      <Text style={{ color: tokens.foreground }}>{detail.goal.goal.userObjective}</Text>
      <Text style={{ color: tokens.foreground }}>
        {t("Starts")}: {new Date(detail.goal.goal.startsAt).toLocaleString()}
      </Text>
      <Text style={{ color: tokens.foreground }}>
        {t("Maximum loss")}: {envelope.maxMissionLoss} {envelope.currency}
      </Text>
      <Text style={{ color: tokens.foreground }}>
        {t("Per trade limit")}: {envelope.maxRiskPerTrade} {envelope.currency}
      </Text>
      <Text style={{ color: tokens.foreground }}>
        {t("Expires")}: {new Date(envelope.expiresAt).toLocaleString()}
      </Text>
      <NativeActionButton
        label={t("Authorization details")}
        prominence="quiet"
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <>
          <Text style={{ color: tokens.mutedForeground }}>
            {t(
              "The profit target is not guaranteed. Capital allocation is an accounting budget, not segregated funds.",
            )}
          </Text>
          <Text selectable style={{ color: tokens.foreground, fontSize: 12 }}>
            {JSON.stringify(envelope, null, 2)}
          </Text>
          {mandate.status === "AWAITING_APPROVAL" && envelope.mode === "SIMULATION" ? (
            <>
              <Text style={{ color: tokens.foreground }}>{t("Total reserved risk limit")}</Text>
              <TextInput
                accessibilityLabel={t("Total reserved risk limit")}
                style={{
                  color: tokens.foreground,
                  borderColor: tokens.border,
                  borderWidth: 1,
                  padding: 8,
                }}
                value={risk}
                onChangeText={setRisk}
                keyboardType="decimal-pad"
                editable={!readOnly && !busy}
              />
              <Text style={{ color: tokens.foreground }}>{t("Total exposure limit")}</Text>
              <TextInput
                accessibilityLabel={t("Total exposure limit")}
                style={{
                  color: tokens.foreground,
                  borderColor: tokens.border,
                  borderWidth: 1,
                  padding: 8,
                }}
                value={exposure}
                onChangeText={setExposure}
                keyboardType="decimal-pad"
                editable={!readOnly && !busy}
              />
              <NativeActionButton
                label={t("Save simulation limits")}
                disabled={readOnly || busy || guardrails?.frozen}
                onPress={() =>
                  void action(async () => {
                    const saved = await rpc(
                      "trading/setAccountGuardrails",
                      guardrails
                        ? { ...guardrails, maxReservedRisk: risk, maxExposure: exposure }
                        : {
                            version: 1,
                            accountId: envelope.accountId,
                            mode: "SIMULATION",
                            maxReservedRisk: risk,
                            maxExposure: exposure,
                            maxPendingExposure: exposure,
                            maxActiveMandates: 1,
                            maxDrawdown: null,
                            maxMarginUsagePercent: envelope.maxMarginUsagePercent,
                            autonomousEnabled: true,
                            frozen: false,
                            revision: 1,
                          },
                    );
                    setGuardrails(AccountRiskGuardrailsSchema.parse(saved));
                  })
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Action rejected. Refresh and review the current mandate.")}
        </Text>
      ) : null}
      {mandate.status === "AWAITING_APPROVAL" ? (
        <>
          <NativeActionButton
            label={t("Approve mandate")}
            disabled={
              readOnly ||
              busy ||
              envelope.mode !== "SIMULATION" ||
              !guardrails?.autonomousEnabled ||
              guardrails.frozen
            }
            onPress={() =>
              Alert.alert(
                t("Approve mandate"),
                t("Approve the exact displayed authorization envelope?"),
                [
                  { text: t("Cancel"), style: "cancel" },
                  { text: t("Approve"), onPress: () => resolve(true) },
                ],
              )
            }
          />
          <NativeActionButton
            label={t("Deny")}
            disabled={readOnly || busy}
            prominence="secondary"
            onPress={() => resolve(false)}
          />
        </>
      ) : null}
      {mandate.status === "ACTIVE" || mandate.status === "APPROVED_WAITING" ? (
        <>
          <NativeActionButton
            label={t("Pause")}
            disabled={readOnly || busy}
            prominence="secondary"
            onPress={() => void control("PAUSE")}
          />
          <NativeActionButton
            label={t("Emergency stop")}
            disabled={readOnly || busy}
            prominence="secondary"
            onPress={() => void control("EMERGENCY_STOP")}
          />
        </>
      ) : null}
      {mandate.status === "ACTIVE" ||
      mandate.status === "APPROVED_WAITING" ||
      mandate.status === "PAUSED" ? (
        <NativeActionButton
          label={t("Cancel mandate")}
          disabled={readOnly || busy}
          prominence="secondary"
          onPress={() => void control("CANCEL")}
        />
      ) : null}
    </View>
  );
}
