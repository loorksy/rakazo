import { Trans } from "@lingui/react/macro";
import type { TradingAccountAccessView } from "@rakazo/contracts";
import { Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function TradingAccountAccess({ botId }: { botId: string }) {
  const id = useId();
  const [rows, setRows] = useState<TradingAccountAccessView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(false);
    setError(undefined);
    void rpc.trading
      .accountAccess({ botId }, { signal: abort.signal })
      .then((next) => {
        if (!abort.signal.aborted) setRows(next);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoaded(true);
      });
    return () => abort.abort();
  }, [botId]);
  async function change(row: TradingAccountAccessView, accountRead: boolean) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await rpc.trading.setAccountAccess({
        botId,
        accountId: row.accountId,
        accountRead,
        expectedRevision: row.revision,
      });
      setRows(await rpc.trading.accountAccess({ botId }));
    } catch (failure) {
      setError(errorText(failure));
      await rpc.trading
        .accountAccess({ botId })
        .then(setRows)
        .catch(() => setRows([]));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-4 space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">
        <Trans>Broker access</Trans>
      </h3>
      {loaded && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No broker account is connected.</Trans>
        </p>
      ) : null}
      {rows.map((row) => {
        const readable = row.accountRead || row.mandateRead;
        return (
          <div key={row.accountId} className="space-y-1 text-sm">
            <p>
              <Trans>Account</Trans>
            </p>
            <p>{row.label}</p>
            <p className="text-muted-foreground">
              <Trans>Market data</Trans>
              {": "}
              <Trans>Available</Trans>
            </p>
            <p className="text-muted-foreground">
              <Trans>Account balance / equity / margin / positions</Trans>
              {": "}
              {readable ? <Trans>Allowed</Trans> : <Trans>Not allowed</Trans>}
            </p>
            <p className="text-muted-foreground">
              <Trans>Execution</Trans>
              {": "}
              {row.mandateRead ? <Trans>Mandate scope</Trans> : <Trans>No authority</Trans>}
            </p>
            <label htmlFor={`${id}-${row.accountId}`} className="flex items-center gap-2 pt-1">
              <Trans>Allow account read</Trans>
              <Switch
                id={`${id}-${row.accountId}`}
                checked={row.accountRead}
                disabled={busy}
                onCheckedChange={(checked) => void change(row, checked)}
              />
            </label>
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
