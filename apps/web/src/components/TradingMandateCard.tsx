import { Trans } from "@lingui/react/macro";
import type {
  AccountRiskGuardrails,
  TradingMandateView,
  TradingMissionDetail,
} from "@rakazo/contracts";
import { TradingMissionDetailSchema } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

/** This card reads current authority. A message snapshot or model text is never approval. */
export function TradingMandateCard({
  goalId,
  mandateId,
  readOnly = false,
}: {
  goalId: string;
  mandateId: string;
  readOnly?: boolean;
}) {
  const inputId = useId();
  const [detail, setDetail] = useState<TradingMissionDetail>();
  const [mandate, setMandate] = useState<TradingMandateView>();
  const [guardrails, setGuardrails] = useState<AccountRiskGuardrails | null>(null);
  const [accountLabel, setAccountLabel] = useState("");
  const [risk, setRisk] = useState("");
  const [exposure, setExposure] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void rpc.trading
      .missions({ operation: "get", goalId }, { signal: abort.signal })
      .then(async (raw) => {
        const current = TradingMissionDetailSchema.parse(raw);
        const selected = current.mandates.find((row) => row.id === mandateId);
        if (!selected) throw new Error("Mandate unavailable");
        const [limits, accounts] = await Promise.all([
          rpc.trading.accountGuardrails(
            { accountId: selected.envelope.accountId, mode: selected.envelope.mode },
            { signal: abort.signal },
          ),
          rpc.trading.connections.list(undefined, { signal: abort.signal }),
        ]);
        if (abort.signal.aborted) return;
        setDetail(current);
        setMandate(selected);
        setGuardrails(limits);
        setAccountLabel(
          accounts.find((row) => row.id === selected.envelope.accountId)?.label ?? "",
        );
        setRisk(limits?.maxReservedRisk ?? selected.envelope.maxMissionLoss);
        setExposure(limits?.maxExposure ?? selected.envelope.maxNotional);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [goalId, mandateId]);
  async function action(task: () => Promise<void>) {
    if (busy || readOnly) return;
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
      <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
        {error ? <Trans>Mission unavailable</Trans> : <Trans>Loading mission…</Trans>}
      </p>
    );
  const envelope = mandate.envelope;
  const pending = mandate.status === "AWAITING_APPROVAL";
  const stopped = [
    "PAUSED",
    "CANCELLED",
    "EXPIRED",
    "COMPLETED",
    "TARGET_REACHED",
    "RISK_STOPPED",
  ].includes(mandate.status);
  return (
    <section
      className="w-full max-w-lg space-y-3 rounded-xl border bg-card p-4 text-sm"
      aria-label="Trading mandate"
    >
      <div className="flex justify-between gap-3">
        <strong>
          <Trans>Trading mission</Trans>
        </strong>
        <span>
          {envelope.mode} · {mandate.status}
        </span>
      </div>
      <p>{detail.goal.goal.userObjective}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt>
          <Trans>Account</Trans>
        </dt>
        <dd>{accountLabel}</dd>
        <dt>
          <Trans>Target</Trans>
        </dt>
        <dd>
          {detail.goal.goal.targetProfit ?? "—"} {envelope.currency}
        </dd>
        <dt>
          <Trans>Maximum loss</Trans>
        </dt>
        <dd>
          {envelope.maxMissionLoss} {envelope.currency}
        </dd>
        <dt>
          <Trans>Open risk limit</Trans>
        </dt>
        <dd>
          {envelope.maxOpenRisk} {envelope.currency}
        </dd>
        <dt>
          <Trans>Per trade limit</Trans>
        </dt>
        <dd>
          {envelope.maxRiskPerTrade} {envelope.currency}
        </dd>
        <dt>
          <Trans>Expires</Trans>
        </dt>
        <dd>{new Date(envelope.expiresAt).toLocaleString()}</dd>
        <dt>
          <Trans>Starts</Trans>
        </dt>
        <dd>{new Date(detail.goal.goal.startsAt).toLocaleString()}</dd>
      </dl>
      <details>
        <summary className="cursor-pointer">
          <Trans>Authorization details</Trans>
        </summary>
        <div className="space-y-2 pt-2">
          <p>
            <Trans>
              The profit target is not guaranteed. Capital allocation is an accounting budget, not
              segregated funds.
            </Trans>
          </p>
          <dl className="grid grid-cols-2 gap-2">
            <dt>
              <Trans>Allocation</Trans>
            </dt>
            <dd>
              {envelope.allocatedCapital} {envelope.currency}
            </dd>
            <dt>
              <Trans>Position limit</Trans>
            </dt>
            <dd>{envelope.maxConcurrentPositions}</dd>
            <dt>
              <Trans>Exposure limit</Trans>
            </dt>
            <dd>
              {envelope.maxNotional} {envelope.currency}
            </dd>
            <dt>
              <Trans>Margin usage limit</Trans>
            </dt>
            <dd>{envelope.maxMarginUsagePercent}%</dd>
            <dt>
              <Trans>Daily loss limit</Trans>
            </dt>
            <dd>
              {envelope.maxDailyLoss ?? "—"} {envelope.currency}
            </dd>
            <dt>
              <Trans>Cost reserve per trade</Trans>
            </dt>
            <dd>
              {envelope.costReservePerTrade} {envelope.currency}
            </dd>
            <dt>
              <Trans>Allowed order types</Trans>
            </dt>
            <dd>{envelope.allowedOrderTypes.join(", ")}</dd>
            <dt>
              <Trans>Allowed instruments</Trans>
            </dt>
            <dd>{envelope.allowedInstruments.join(", ")}</dd>
            <dt>
              <Trans>Supervised position</Trans>
            </dt>
            <dd>{envelope.supervisionPositionId ?? "—"}</dd>
            <dt>
              <Trans>Supervised orders</Trans>
            </dt>
            <dd>{envelope.supervisedOrderIds.join(", ") || "—"}</dd>
            <dt>
              <Trans>Pending order limit</Trans>
            </dt>
            <dd>{envelope.maxPendingOrders}</dd>
            <dt>
              <Trans>Allowed actions</Trans>
            </dt>
            <dd>{envelope.allowedOperations.join(", ")}</dd>
            <dt>
              <Trans>Risk-increase permissions</Trans>
            </dt>
            <dd>{envelope.riskIncreasePermissions.join(", ") || "—"}</dd>
            <dt>
              <Trans>Breach behavior</Trans>
            </dt>
            <dd>{envelope.breachBehavior}</dd>
            <dt>
              <Trans>Expiry behavior</Trans>
            </dt>
            <dd>{envelope.expiryBehavior}</dd>
            <dt>
              <Trans>Target behavior</Trans>
            </dt>
            <dd>{envelope.targetBehavior}</dd>
          </dl>
        </div>
      </details>
      {pending && envelope.mode === "SIMULATION" ? (
        <details>
          <summary className="cursor-pointer">
            <Trans>Account guardrails</Trans>
          </summary>
          <div className="space-y-2 pt-2">
            <label className="block" htmlFor={`${inputId}-risk`}>
              <Trans>Total reserved risk limit</Trans>
              <Input
                id={`${inputId}-risk`}
                value={risk}
                inputMode="decimal"
                onChange={(event) => setRisk(event.target.value)}
                disabled={busy || readOnly}
              />
            </label>
            <label className="block" htmlFor={`${inputId}-exposure`}>
              <Trans>Total exposure limit</Trans>
              <Input
                id={`${inputId}-exposure`}
                value={exposure}
                inputMode="decimal"
                onChange={(event) => setExposure(event.target.value)}
                disabled={busy || readOnly}
              />
            </label>
            <Button
              disabled={busy || readOnly || guardrails?.frozen}
              onClick={() =>
                void action(async () => {
                  const saved = await rpc.trading.setAccountGuardrails(
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
                  setGuardrails(saved);
                })
              }
            >
              <Trans>Save simulation limits</Trans>
            </Button>
          </div>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          <Trans>Action rejected. Refresh and review the current mandate.</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pending ? (
          <>
            <Button
              disabled={
                busy ||
                readOnly ||
                envelope.mode !== "SIMULATION" ||
                !guardrails?.autonomousEnabled ||
                guardrails.frozen
              }
              onClick={() =>
                void action(async () =>
                  setMandate(
                    await rpc.trading.resolveMandate({
                      id: mandate.id,
                      expectedRevision: mandate.revision,
                      fingerprint: mandate.fingerprint,
                      approve: true,
                    }),
                  ),
                )
              }
            >
              <Trans>Approve mandate</Trans>
            </Button>
            <Button
              variant="outline"
              disabled={busy || readOnly}
              onClick={() =>
                void action(async () =>
                  setMandate(
                    await rpc.trading.resolveMandate({
                      id: mandate.id,
                      expectedRevision: mandate.revision,
                      fingerprint: mandate.fingerprint,
                      approve: false,
                    }),
                  ),
                )
              }
            >
              <Trans>Deny</Trans>
            </Button>
          </>
        ) : stopped ? null : (
          <>
            <Button
              variant="outline"
              disabled={busy || readOnly}
              onClick={() =>
                void action(async () =>
                  setMandate(
                    await rpc.trading.controlMandate({
                      id: mandate.id,
                      expectedRevision: mandate.revision,
                      action: "PAUSE",
                    }),
                  ),
                )
              }
            >
              <Trans>Pause</Trans>
            </Button>
            <Button
              variant="outline"
              disabled={busy || readOnly}
              onClick={() =>
                void action(async () =>
                  setMandate(
                    await rpc.trading.controlMandate({
                      id: mandate.id,
                      expectedRevision: mandate.revision,
                      action: "EMERGENCY_STOP",
                    }),
                  ),
                )
              }
            >
              <Trans>Emergency stop</Trans>
            </Button>
          </>
        )}
        {mandate.status === "ACTIVE" ||
        mandate.status === "APPROVED_WAITING" ||
        mandate.status === "PAUSED" ? (
          <Button
            variant="outline"
            disabled={busy || readOnly}
            onClick={() =>
              void action(async () =>
                setMandate(
                  await rpc.trading.controlMandate({
                    id: mandate.id,
                    expectedRevision: mandate.revision,
                    action: "CANCEL",
                  }),
                ),
              )
            }
          >
            <Trans>Cancel mandate</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
