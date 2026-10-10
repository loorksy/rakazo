import { Trans } from "@lingui/react/macro";
import type { TradingAccountAccessView } from "@rakazo/contracts";
import { Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function TradingAccountAccess({ botId }: { botId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TradingAccountAccessView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setRows([]);
    setError(undefined);
    void rpc.trading
      .accountAccess({ botId }, { signal: abort.signal })
      .then(setRows)
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure));
      });
    return () => abort.abort();
  }, [botId, open]);
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
      // A conflict must be reloaded before another owner intent is accepted.
      await rpc.trading
        .accountAccess({ botId })
        .then(setRows)
        .catch(() => setRows([]));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="mt-4 border-t border-border pt-4"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        <Trans>Account access</Trans>
      </summary>
      {open ? (
        <div className="mt-3 space-y-3">
          {rows.map((row) => (
            <div key={row.accountId} className="flex items-center justify-between gap-3 text-sm">
              <div>
                <p>{row.label}</p>
                {row.mandateRead ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>Read access through active mandate</Trans>
                  </p>
                ) : null}
              </div>
              <label htmlFor={`${id}-${row.accountId}`} className="flex items-center gap-2">
                <Trans>Account read</Trans>
                <Switch
                  id={`${id}-${row.accountId}`}
                  checked={row.accountRead}
                  disabled={busy}
                  onCheckedChange={(checked) => void change(row, checked)}
                />
              </label>
            </div>
          ))}
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
