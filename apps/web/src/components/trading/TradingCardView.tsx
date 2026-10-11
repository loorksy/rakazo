import { Trans } from "@lingui/react/macro";
import type { TradingCard } from "@rakazo/contracts";
import { executionFingerprint, previewProtection } from "@rakazo/core";
import { useState } from "react";
import { publishChartFocus } from "../../lib/chart-focus";

function ltr(value: string | null | undefined) {
  if (!value) return "—";
  return (
    <span dir="ltr" className="inline-block font-medium tabular-nums">
      {value}
    </span>
  );
}

function marketLabel(card: TradingCard) {
  return "market" in card && card.market ? card.market.brokerSymbol : null;
}

export function TradingCardView({ card }: { card: TradingCard }) {
  const [reportOpen, setReportOpen] = useState(false);
  const [volume, setVolume] = useState(card.type === "EXECUTION_PREVIEW" ? card.volume : "");
  const symbol = marketLabel(card);
  const openChart = () => {
    if (!("market" in card) || !card.market) return;
    publishChartFocus({
      accountId: card.market.accountId,
      instrumentId: card.market.instrumentId,
      brokerSymbol: card.market.brokerSymbol,
      timeframe: "timeframe" in card ? card.timeframe : undefined,
    });
  };
  const preview =
    card.type === "EXECUTION_PREVIEW"
      ? previewProtection({
          side: card.side,
          entry: card.entry ?? "0",
          stop: card.stopLoss,
          target: card.target,
          volume,
          contractSize: null,
        })
      : null;
  const fingerprint =
    card.type === "EXECUTION_PREVIEW"
      ? executionFingerprint([
          card.market.instrumentId,
          card.side,
          card.orderType,
          card.entry ?? "",
          card.stopLoss ?? "",
          card.target ?? "",
          volume,
        ])
      : "";
  const stale = card.type === "EXECUTION_PREVIEW" && fingerprint !== card.fingerprint;
  return (
    <article
      dir="auto"
      className="w-full max-w-md rounded-2xl border border-border bg-card p-4 text-card-foreground"
      data-testid={`trading-card-${card.type}`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          {symbol ? (
            <div dir="ltr" className="text-lg font-semibold">
              {symbol}
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">{card.type.replaceAll("_", " ")}</div>
        </div>
        {card.type === "RECOMMENDATION" ? (
          <div
            className={
              card.side === "BUY"
                ? "text-success"
                : card.side === "SELL"
                  ? "text-destructive"
                  : "text-foreground"
            }
          >
            {card.side}
          </div>
        ) : null}
      </header>
      {card.type === "RECOMMENDATION" ? (
        <div className="mt-3 space-y-1 text-sm">
          <div>
            <Trans>Price</Trans> {ltr(card.currentPrice)}
          </div>
          <div>
            <Trans>Entry</Trans> {ltr(card.entry)}
          </div>
          <div>
            <Trans>Stop</Trans> {ltr(card.stopLoss)}
          </div>
          <div>
            <Trans>Target</Trans> {ltr(card.target)}
          </div>
          <div>
            <Trans>Risk / reward</Trans> {ltr(card.riskReward)}
          </div>
          <div className="text-muted-foreground">
            {card.market.provider} · {card.timeframe} · {card.freshness}
          </div>
          <p className="text-muted-foreground">
            <Trans>Position size is unavailable without account read.</Trans>
          </p>
          <div className="flex gap-2 pt-2">
            <button type="button" className="text-sm underline" onClick={openChart}>
              <Trans>Open chart</Trans>
            </button>
            {card.reportTitle ? (
              <button
                type="button"
                className="text-sm underline"
                onClick={() => setReportOpen(true)}
              >
                <Trans>View report</Trans>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {card.type === "LIVE_PRICE" ? (
        <div className="mt-3 text-sm">
          <div>
            <Trans>Bid</Trans> {ltr(card.bid)}
          </div>
          <div>
            <Trans>Ask</Trans> {ltr(card.ask)}
          </div>
          <div className="text-muted-foreground">{card.freshness}</div>
        </div>
      ) : null}
      {card.type === "REPORT" ? (
        <div className="mt-3">
          <div className="font-medium">{card.title}</div>
          <button
            type="button"
            className="mt-2 text-sm underline"
            onClick={() => setReportOpen(true)}
          >
            <Trans>View report</Trans>
          </button>
        </div>
      ) : null}
      {card.type === "EXECUTION_PREVIEW" ? (
        <div className="mt-3 space-y-2 text-sm">
          <div>
            {card.mode} · {card.environment ?? "—"} · {card.side} · {card.orderType}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease lot"
              onClick={() => setVolume((current) => stepVolume(current, -1))}
            >
              −
            </button>
            <span dir="ltr">{volume}</span>
            <button
              type="button"
              aria-label="Increase lot"
              onClick={() => setVolume((current) => stepVolume(current, 1))}
            >
              +
            </button>
          </div>
          <div>
            <Trans>Estimated loss</Trans>{" "}
            {ltr(volume === card.volume ? card.estimatedLoss : (preview?.loss ?? null))}
          </div>
          <div>
            <Trans>Estimated profit</Trans>{" "}
            {ltr(volume === card.volume ? card.estimatedProfit : (preview?.profit ?? null))}
          </div>
          {stale ? (
            <p>
              <Trans>This preview changed. The previous approval no longer applies.</Trans>
            </p>
          ) : null}
          <button type="button" disabled className="rounded-lg border border-border px-3 py-1">
            <Trans>Execute</Trans>
          </button>
          <p className="text-muted-foreground">
            <Trans>
              Execution stays on the trusted financial path. This card cannot place an order.
            </Trans>
          </p>
        </div>
      ) : null}
      {card.type === "ACCOUNT_STATUS" ? (
        <div className="mt-3 text-sm">
          <div>{card.label}</div>
          <div>{card.environment ?? "—"}</div>
          <div>{card.connected ? <Trans>Connected</Trans> : <Trans>Disconnected</Trans>}</div>
          <div>
            {card.accountRead ? (
              <Trans>Account read allowed</Trans>
            ) : (
              <Trans>Account read is not granted</Trans>
            )}
          </div>
          <div>{card.execution}</div>
        </div>
      ) : null}
      {card.type === "AUTHORITY" ? <p className="mt-3 text-sm">{card.note}</p> : null}
      {"note" in card && card.type !== "AUTHORITY" ? (
        <p className="mt-3 text-sm">{card.note}</p>
      ) : null}
      {card.type === "SUMMARY" || card.type === "PLAN" ? (
        <p className="mt-3 text-sm">{card.type === "SUMMARY" ? card.body : card.summary}</p>
      ) : null}
      {card.type === "CHART" ? (
        <button type="button" className="mt-3 text-sm underline" onClick={openChart}>
          <Trans>Open chart</Trans>
        </button>
      ) : null}
      {reportOpen && card.type === "REPORT" ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3" data-testid="trading-report">
          {card.sections.map((section) => (
            <section key={section.heading}>
              <h3 className="text-sm font-medium">{section.heading}</h3>
              <p className="text-sm text-muted-foreground">{section.body}</p>
            </section>
          ))}
        </div>
      ) : null}
      {reportOpen && card.type === "RECOMMENDATION" && card.reportTitle ? (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="trading-report">
          {card.reportTitle}
        </p>
      ) : null}
    </article>
  );
}

function stepVolume(current: string, direction: number) {
  const value = Number(current);
  if (!Number.isFinite(value)) return current;
  const next = Math.max(0.01, Math.round((value + direction * 0.01) * 100) / 100);
  return next.toFixed(2);
}
