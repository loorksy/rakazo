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
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<TradingConnectionView[]>([]);
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState("");
  const [region, setRegion] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void rpc.trading.connections
      .list()
      .then((rows) => {
        if (active) setAccounts(rows);
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [open]);
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
  return (
    <details
      className="border-t border-border pt-4"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        <Trans>Broker accounts</Trans>
      </summary>
      {open ? (
        <div className="mt-4 space-y-4">
          {accounts
            .filter((row) => !row.revokedAt)
            .map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-3 text-sm">
                <div>
                  <p>{row.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.state} {row.environment ?? ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revoke(row.id)}
                >
                  <Trans>Disconnect</Trans>
                </Button>
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
              {busy ? t`Saving…` : t`Connect account`}
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
