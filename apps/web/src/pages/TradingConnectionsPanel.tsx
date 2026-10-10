import { Trans, useLingui } from "@lingui/react/macro";
import type { TradingConnectionView } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { TradingJournal } from "../components/TradingJournal";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** Contextual connection settings, not another navigation destination. */
export function TradingConnectionsPanel() {
  const { t } = useLingui();
  const prefix = useId();
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState<TradingConnectionView[]>([]);
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState("");
  const [region, setRegion] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void rpc.trading.connections
      .list()
      .then((rows) => {
        if (active) setAccounts(rows);
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
  }, []);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.trading.connections.save({
        label,
        providerAccountId: account,
        region: region || undefined,
        token,
      });
      setToken("");
      setAccount("");
      setLabel("");
      setAccounts(await rpc.trading.connections.list());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  async function verify(accountId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.trading.connections.verify({ accountId });
      setAccounts(await rpc.trading.connections.list());
      setError(null);
      setVerified(
        `${result.environment ?? ""} ${result.currency ?? ""}`.trim() || result.accountId,
      );
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
      await rpc.trading.connections.revoke({ accountId });
      setAccounts(await rpc.trading.connections.list());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  const active = accounts.filter((row) => !row.revokedAt);
  const connected = active.filter((row) => row.state === "CONNECTED").length;
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">
          <Trans>Broker accounts</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          {loaded ? (
            connected > 0 ? (
              <Trans>{connected} connected</Trans>
            ) : (
              <Trans>No broker accounts connected</Trans>
            )
          ) : (
            <Trans>Loading broker accounts…</Trans>
          )}
        </p>
      </div>
      {loaded ? (
        <div className="space-y-4">
          {active.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 text-sm">
              <div>
                <p className="font-medium">{row.label}</p>
                <p className="text-xs text-muted-foreground">MetaApi</p>
                <p className="text-xs">{row.state}</p>
                <p className="text-xs text-muted-foreground">
                  {[row.environment, row.currency].filter(Boolean).join(" · ")}
                  {row.failureCode ? ` · ${row.failureCode}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  <Trans>Last healthy</Trans>{" "}
                  {row.lastHealthyAt ? new Date(row.lastHealthyAt).toLocaleString() : "—"}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void verify(row.id)}
                >
                  <Trans>Verify</Trans>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setLabel(row.label);
                    setAccount(row.providerAccountId);
                    setRegion(row.region ?? "");
                    setToken("");
                  }}
                >
                  <Trans>Rotate token</Trans>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revoke(row.id)}
                >
                  <Trans>Disconnect</Trans>
                </Button>
              </div>
            </div>
          ))}
          <TradingJournal />
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${prefix}-label`}>
                <Trans>Account name</Trans>
              </FieldLabel>
              <Input
                id={`${prefix}-label`}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={80}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-account`}>
                <Trans>MetaApi account ID</Trans>
              </FieldLabel>
              <Input
                id={`${prefix}-account`}
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                maxLength={128}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-region`}>
                <Trans>Region (optional)</Trans>
              </FieldLabel>
              <Input
                id={`${prefix}-region`}
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                maxLength={32}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-token`}>
                <Trans>API token</Trans>
              </FieldLabel>
              <Input
                id={`${prefix}-token`}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
              />
            </Field>
            <Button type="submit" disabled={busy || !label || !account || !token}>
              {busy ? t`Saving…` : t`Connect MetaApi account`}
            </Button>
          </form>
          {verified ? <p className="text-sm text-muted-foreground">{verified}</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
