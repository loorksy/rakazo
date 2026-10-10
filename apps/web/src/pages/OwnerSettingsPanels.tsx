import { Trans, useLingui } from "@lingui/react/macro";
import type {
  DeploymentConfigView,
  PlaybookSettingsView,
  TradingLiveStatus,
} from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { TradingConnectionsPanel } from "./TradingConnectionsPanel";

const RUNTIME_LABELS = {
  computerMemory: "Computer memory",
  computerCpus: "Computer CPUs",
  computerPidsLimit: "Process limit",
  sandboxIdleMs: "Idle timeout (ms)",
  maxToolCallsPerTurn: "Tool-call limit",
  graphileWorkerConcurrency: "Worker concurrency",
  logLevel: "Log level",
  axiomDataset: "Axiom dataset",
  economicCalendarProvider: "Calendar provider",
} as const;

/** Owner trading section: broker accounts, live admission and the shared playbook. */
export function TradingSettingsPanel() {
  const { t } = useLingui();
  const [live, setLive] = useState<TradingLiveStatus | null>(null);
  const [playbook, setPlaybook] = useState<PlaybookSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([rpc.trading.liveStatus(), rpc.trading.playbook()])
      .then(([status, knowledge]) => {
        if (!active) return;
        setLive(status);
        setPlaybook(knowledge);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, []);
  async function toggleGroup(id: PlaybookSettingsView["groups"][number]["id"]) {
    if (!playbook || busy) return;
    setBusy(true);
    setError(null);
    const disabledGroups = playbook.groups.flatMap((group) =>
      group.id === id ? (group.enabled ? [group.id] : []) : group.enabled ? [] : [group.id],
    );
    try {
      setPlaybook(
        await rpc.trading.setPlaybook({ expectedRevision: playbook.revision, disabledGroups }),
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  async function abandon(effectId: string) {
    setBusy(true);
    setError(null);
    try {
      await rpc.trading.abandonEffect({ effectId });
      setLive(await rpc.trading.liveStatus());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-8">
      <TradingConnectionsPanel />
      {live ? (
        <section className="space-y-2 text-sm">
          <h3 className="font-medium">
            <Trans>LIVE</Trans>
          </h3>
          <p className="text-muted-foreground">
            {live.enabled ? t`Enabled` : t`Disabled`}
            {" · "}
            {live.runtime.containment ? t`Containment verified` : t`Containment unverified`}
          </p>
          {live.accounts.flatMap((account) =>
            account.uncertainEffects.map((effect) => (
              <div key={effect.effectId} className="flex items-center justify-between gap-3">
                <span>
                  {account.label} · {effect.status}
                </span>
                {effect.abandonable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void abandon(effect.effectId)}
                  >
                    <Trans>Abandon unknown outcome</Trans>
                  </Button>
                ) : null}
              </div>
            )),
          )}
        </section>
      ) : null}
      {playbook ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">
            <Trans>Trading knowledge</Trans> {playbook.version}
          </h3>
          {playbook.groups.map((group) => (
            <label key={group.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {group.label} · {group.rules}
              </span>
              <input
                type="checkbox"
                checked={group.enabled}
                disabled={busy}
                onChange={() => void toggleGroup(group.id)}
              />
            </label>
          ))}
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Allowlisted runtime and observability settings. Bootstrap secrets show presence only. */
export function DeploymentSettingsPanel({ part }: { part: "runtime" | "observability" }) {
  const { t } = useLingui();
  const prefix = useId();
  const [view, setView] = useState<DeploymentConfigView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.deployment
      .config()
      .then((next) => {
        if (!active) return;
        setView(next);
        setDrafts(
          Object.fromEntries(
            next.settings.map((row) => [row.key, row.value === null ? "" : String(row.value)]),
          ),
        );
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (!view || busy) return;
    setBusy(true);
    setError(null);
    const runtime: Record<string, string | number | null> = {};
    for (const row of view.settings) {
      if (part === "observability" && row.key !== "axiomDataset" && row.key !== "logLevel")
        continue;
      if (part === "runtime" && (row.key === "axiomDataset" || row.key === "logLevel")) continue;
      const draft = drafts[row.key]?.trim() ?? "";
      const current = row.value === null ? "" : String(row.value);
      if (draft === current) continue;
      if (!draft) runtime[row.key] = null;
      else if (
        typeof row.effective === "number" ||
        [
          "computerPidsLimit",
          "sandboxIdleMs",
          "maxToolCallsPerTurn",
          "graphileWorkerConcurrency",
        ].includes(row.key)
      )
        runtime[row.key] = Number(draft);
      else runtime[row.key] = draft;
    }
    try {
      let next = view;
      if (Object.keys(runtime).length)
        next = await rpc.deployment.updateConfig({ expectedRevision: view.revision, runtime });
      if (part === "observability" && token.trim())
        next = await rpc.deployment.setSecret({
          expectedRevision: next.revision,
          key: "observability.axiomToken",
          value: token.trim(),
        });
      setView(next);
      setToken("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  const settings =
    view?.settings.filter((row) =>
      part === "observability"
        ? row.key === "axiomDataset" || row.key === "logLevel"
        : row.key !== "axiomDataset" && row.key !== "logLevel",
    ) ?? [];
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {part === "observability" && view ? (
        <section className="space-y-1 text-sm">
          <p>
            <Trans>Containment</Trans>
            {": "}
            {view.containment.mode ?? "—"}
            {view.containment.verified ? ` · ${t`verified`}` : ""}
          </p>
          {view.bootstrap.map((row) => (
            <p key={row.name} className="text-muted-foreground">
              {row.name} ·{" "}
              {row.status === "CONFIGURED"
                ? t`Configured`
                : row.status === "MISSING"
                  ? t`Missing`
                  : row.status === "PLACEHOLDER"
                    ? t`Placeholder`
                    : t`Unknown`}
            </p>
          ))}
        </section>
      ) : null}
      {settings.map((row) => (
        <Field key={row.key}>
          <FieldLabel htmlFor={`${prefix}-${row.key}`}>{RUNTIME_LABELS[row.key]}</FieldLabel>
          <Input
            id={`${prefix}-${row.key}`}
            value={drafts[row.key] ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [row.key]: event.target.value }))
            }
          />
          <p className="text-xs text-muted-foreground">
            {row.env}
            {row.restartRequired.length
              ? ` · ${t`Restart required`}`
              : row.apply === "NEW_COMPUTERS"
                ? ` · ${t`New computers`}`
                : ""}
          </p>
        </Field>
      ))}
      {part === "observability" ? (
        <Field>
          <FieldLabel htmlFor={`${prefix}-axiom`}>
            <Trans>Axiom token</Trans>
          </FieldLabel>
          <Input
            id={`${prefix}-axiom`}
            type="password"
            autoComplete="off"
            value={token}
            placeholder={
              view?.secrets.find((row) => row.key === "observability.axiomToken")?.configured
                ? t`Configured`
                : ""
            }
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      ) : null}
      <Button type="submit" disabled={busy || !view}>
        {busy ? t`Saving…` : t`Save`}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
