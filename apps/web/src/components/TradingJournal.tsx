import { Trans } from "@lingui/react/macro";
import type { TradingJournalPage } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function TradingJournal({
  accountId,
  mandateId,
}: {
  accountId?: string;
  mandateId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<TradingJournalPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setPage(undefined);
    setError(undefined);
    void rpc.trading
      .journal({ accountId, mandateId, limit: 30 }, { signal: abort.signal })
      .then(setPage)
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure));
      });
    return () => abort.abort();
  }, [accountId, mandateId, open]);
  async function more() {
    if (busy || !page?.nextCursor) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await rpc.trading.journal({
        accountId,
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
    <details className="mt-3" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">
        <Trans>Journal</Trans>
      </summary>
      {open ? (
        <div className="mt-3 space-y-3">
          {page?.entries.map((entry) => (
            <details key={entry.id} className="rounded-lg border border-border p-3 text-xs">
              <summary className="cursor-pointer">
                <span>{entry.event.replaceAll("_", " ")}</span>
                <span className="ml-2 text-muted-foreground">
                  {entry.mode} · {new Date(entry.createdAt).toLocaleString()}
                </span>
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(entry.entry, null, 2)}
              </pre>
            </details>
          ))}
          {page && !page.entries.length ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No financial events</Trans>
            </p>
          ) : null}
          {page?.nextCursor ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>
              <Trans>Load more</Trans>
            </Button>
          ) : null}
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
