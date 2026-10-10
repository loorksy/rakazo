import { Trans, useLingui } from "@lingui/react/macro";
import type {
  DeploymentConfigView,
  DeploymentRuntimeKey,
  PlaybookSettingsView,
  TradingLiveStatus,
} from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { TradingConnectionsPanel } from "./TradingConnectionsPanel";

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
  function playbookGroupTitle(id: string) {
    switch (id) {
      case "entry-timing":
        return t`Entry timing`;
      case "retest":
        return t`Retests`;
      case "trendline":
        return t`Trendlines`;
      case "candle":
        return t`Candles`;
      case "targets":
        return t`Targets`;
      case "execution":
        return t`Execution discipline`;
      case "news-protocol":
        return t`News protection`;
      case "news-candle":
        return t`News-candle detection`;
      case "xauusd-behavior":
        return t`Gold-specific behavior`;
      default:
        return id;
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
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">
              <Trans>Trading knowledge</Trans> {playbook.version}
            </h3>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Rules are selected contextually. They are not all sent on every Agent turn.
              </Trans>
            </p>
            <p className="text-sm text-muted-foreground">
              <Trans>Hard safety rules cannot be disabled.</Trans>
            </p>
          </div>
          {playbook.groups.map((group) => (
            <label key={group.id} className="flex items-start justify-between gap-3 text-sm">
              <span>
                <span className="block">{playbookGroupTitle(group.id)}</span>
                <span className="text-muted-foreground">
                  <Trans>{group.rules} contextual trading rules</Trans>
                  {group.id === "xauusd-behavior" ? (
                    <>
                      {" · "}
                      <Trans>Only applied to gold instruments</Trans>
                    </>
                  ) : null}
                  {" · "}
                  {group.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
                </span>
              </span>
              <input
                type="checkbox"
                checked={group.enabled}
                disabled={busy}
                aria-label={playbookGroupTitle(group.id)}
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
  const [calendarKey, setCalendarKey] = useState("");
  const [calendarState, setCalendarState] = useState<string | null>(null);
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
      if (part === "runtime" && calendarKey.trim())
        next = await rpc.deployment.setSecret({
          expectedRevision: next.revision,
          key: "economicCalendar.apiKey",
          value: calendarKey.trim(),
        });
      setView(next);
      setToken("");
      setCalendarKey("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  function settingCopy(key: DeploymentRuntimeKey) {
    switch (key) {
      case "computerMemory":
        return {
          title: t`Computer memory`,
          detail: t`Maximum memory available to each Agent Computer.`,
          applies: t`Applies to new Computers`,
        };
      case "computerCpus":
        return {
          title: t`Computer processors`,
          detail: t`Processor limit for each Agent Computer.`,
          applies: t`Applies to new Computers`,
        };
      case "computerPidsLimit":
        return {
          title: t`Computer process limit`,
          detail: t`Maximum processes inside each Agent Computer.`,
          applies: t`Applies to new Computers`,
        };
      case "sandboxIdleMs":
        return {
          title: t`Computer idle timeout`,
          detail: t`How long an idle Computer stays running, in milliseconds.`,
          applies: t`Applies immediately`,
        };
      case "maxToolCallsPerTurn":
        return {
          title: t`Tool-call limit`,
          detail: t`Maximum tool calls in one Agent turn. Empty leaves the limit off.`,
          applies: t`Applies immediately`,
        };
      case "graphileWorkerConcurrency":
        return {
          title: t`Worker concurrency`,
          detail: t`Number of background jobs the Worker may process at once.`,
          applies: t`Restart required`,
        };
      case "logLevel":
        return {
          title: t`Log level`,
          detail: t`How much the API and Worker write to their logs.`,
          applies: t`Restart required`,
        };
      case "axiomDataset":
        return {
          title: t`Axiom dataset`,
          detail: t`Dataset name for optional log shipping.`,
          applies: t`Restart required`,
        };
      case "economicCalendarProvider":
        return {
          title: t`Calendar provider`,
          detail: t`Used for scheduled economic events and Trading Agent news context.`,
          applies: t`Applies immediately`,
        };
      default: {
        const unhandled: never = key;
        return { title: unhandled, detail: unhandled, applies: unhandled };
      }
    }
  }
  function currentValue(row: DeploymentConfigView["settings"][number]) {
    if (row.key === "economicCalendarProvider") {
      if (row.effective === "fmp") return t`Financial Modeling Prep`;
      if (row.effective === "finnhub") return t`Finnhub`;
      return t`Disabled`;
    }
    if (row.effective === null || row.effective === "") return t`Default`;
    return String(row.effective);
  }
  const bootstrapTitle = (name: string) => {
    switch (name) {
      case "DATABASE_URL":
        return t`Database URL`;
      case "POSTGRES_PASSWORD":
        return t`Postgres password`;
      case "BETTER_AUTH_SECRET":
        return t`Authentication secret`;
      case "ENCRYPTION_KEY":
        return t`Encryption key`;
      case "SANDBOX_SUPERVISOR_TOKEN":
        return t`Sandbox supervisor token`;
      case "SCREEN_PROXY_SECRET":
        return t`Screen proxy secret`;
      default:
        return name;
    }
  };
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
          <p className="text-muted-foreground">
            <Trans>These deployment checks are read-only. Values are never shown.</Trans>
          </p>
          {view.bootstrap.map((row) => (
            <p key={row.name}>
              {bootstrapTitle(row.name)}
              {" — "}
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
      {settings.map((row) => {
        const copy = settingCopy(row.key);
        return (
          <Field key={row.key}>
            <FieldLabel htmlFor={`${prefix}-${row.key}`}>{copy.title}</FieldLabel>
            <p className="text-sm text-muted-foreground">{copy.detail}</p>
            <p className="text-sm">
              <Trans>Current</Trans>: {currentValue(row)}
            </p>
            {row.key === "economicCalendarProvider" ? (
              <select
                id={`${prefix}-${row.key}`}
                aria-label={copy.title}
                className="w-full rounded-lg border border-border bg-card px-2 py-1 text-sm"
                value={drafts[row.key] ?? ""}
                onChange={(event) =>
                  setDrafts((state) => ({ ...state, [row.key]: event.target.value }))
                }
              >
                <option value="">{t`Disabled`}</option>
                <option value="fmp">{t`Financial Modeling Prep`}</option>
                <option value="finnhub">{t`Finnhub`}</option>
              </select>
            ) : (
              <Input
                id={`${prefix}-${row.key}`}
                value={drafts[row.key] ?? ""}
                placeholder={currentValue(row)}
                onChange={(event) =>
                  setDrafts((state) => ({ ...state, [row.key]: event.target.value }))
                }
              />
            )}
            <p className="text-xs text-muted-foreground">
              <Trans>Environment key</Trans>: {row.env}
            </p>
            <p className="text-xs text-muted-foreground">
              {row.restartRequired.length ? <Trans>Restart required</Trans> : copy.applies}
            </p>
          </Field>
        );
      })}
      {part === "runtime" && drafts.economicCalendarProvider ? (
        <Field>
          <FieldLabel htmlFor={`${prefix}-calendar`}>
            <Trans>Calendar API key</Trans>
          </FieldLabel>
          <p className="text-sm text-muted-foreground">
            <Trans>Used for scheduled economic events and Trading Agent news context.</Trans>
          </p>
          <p className="text-xs text-muted-foreground">
            <Trans>Write-only. The saved key is never shown again.</Trans>
          </p>
          <Input
            id={`${prefix}-calendar`}
            type="password"
            autoComplete="off"
            value={calendarKey}
            placeholder={
              view?.secrets.find((row) => row.key === "economicCalendar.apiKey")?.configured
                ? t`Configured`
                : ""
            }
            onChange={(event) => setCalendarKey(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void rpc.deployment
                .calendarStatus()
                .then((status) =>
                  setCalendarState(
                    status.status === "OK"
                      ? t`Calendar connected`
                      : status.status === "UNAVAILABLE"
                        ? t`Calendar unavailable`
                        : t`Calendar disabled`,
                  ),
                )
                .catch((failure) => setError(errorText(failure)))
            }
          >
            <Trans>Test calendar</Trans>
          </Button>
          {calendarState ? <p className="text-sm text-muted-foreground">{calendarState}</p> : null}
        </Field>
      ) : null}
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
