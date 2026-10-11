import { PlaybookGroupIdSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { financialUnits } from "./financial-decimal.js";
import {
  averageRange,
  bodyRangeRatio,
  instrumentExposure,
  macroExposure,
  newsCandleEvidence,
  newsPhaseForCurrencies,
  PLAYBOOK_GROUPS,
  rangeMultiple,
  resolvePlaybookAction,
  selectPlaybook,
  spreadMultiple,
  TRADING_PLAYBOOK,
  tradingSessions,
  zScore,
} from "./trading-playbook.js";

const ids = (symbol: string, extra: Parameters<typeof selectPlaybook>[0] = {}) =>
  selectPlaybook({ symbol, ...extra }).rules.map((rule) => rule.id);

describe("trading playbook retrieval", () => {
  it("keeps owner-toggleable groups aligned with the settings contract", () => {
    expect(PLAYBOOK_GROUPS.map(([id]) => id).sort()).toEqual(
      [...PlaybookGroupIdSchema.options].sort(),
    );
  });
  it("gives a gold instrument the universal foundation plus gold-only context", () => {
    const selected = ids("XAUUSD", { intent: "ANALYZE" });
    expect(selected).toContain("STRUCTURE.RECLAIM");
    expect(selected).toContain("XAU.SAFE_HAVEN");
    expect(selected).toContain("XAU.YIELDS");
    expect(macroExposure("XAUUSD").map((row) => row.currency)).toEqual(["XAU", "USD"]);
  });

  it.each(["EURUSD", "EURUSDm", "EURUSD.pro", "EURUSD-ECN", "mEURUSD"])(
    "classifies %s as euro-dollar without using it as an execution symbol",
    (symbol) => {
      expect(instrumentExposure(symbol)).toMatchObject({
        instrumentClass: "FX",
        currencies: ["EUR", "USD"],
        root: symbol.split(/[^A-Za-z0-9]/)[0]?.toUpperCase(),
      });
      expect(selectPlaybook({ symbol }).rules.some((rule) => rule.scope === "XAUUSD")).toBe(false);
    },
  );
  it.each(["GBPJPY", "GBPJPYraw"])("classifies %s as sterling-yen", (symbol) => {
    expect(instrumentExposure(symbol).currencies).toEqual(["GBP", "JPY"]);
    expect(macroExposure(symbol).map((row) => row.bank)).toEqual([
      "Bank of England",
      "Bank of Japan",
    ]);
  });
  it.each(["XAUUSD", "XAUUSDm", "XAUUSD.pro", "mXAUUSD", "GOLD.m"])(
    "keeps %s on the gold playbook",
    (symbol) => {
      const selected = selectPlaybook({ symbol, intent: "ANALYZE" });
      expect(selected.exposure?.instrumentClass).toBe("METAL");
      expect(selected.exposure?.currencies).toEqual(["XAU", "USD"]);
      expect(selected.rules.map((rule) => rule.id)).toContain("XAU.SAFE_HAVEN");
    },
  );
  it("uses broker specification currencies and does not guess an ambiguous symbol", () => {
    expect(
      instrumentExposure("BROKER-ALIAS", { baseCurrency: "GBP", quoteCurrency: "JPY" }).currencies,
    ).toEqual(["GBP", "JPY"]);
    expect(instrumentExposure("EURUSDEUR").instrumentClass).toBe("OTHER");
    expect(instrumentExposure("EURUSDEUR").currencies).toEqual([]);
  });
  it.each([
    ["BTCUSDTm", "CRYPTO"],
    ["ETHUSDm", "CRYPTO"],
    ["NAS100", "INDEX"],
    ["USTECm", "INDEX"],
    ["US30m", "INDEX"],
    ["USOIL", "ENERGY"],
    ["UKOILm", "ENERGY"],
  ] as const)(
    "classifies %s as %s without borrowing another market's rules",
    (symbol, instrumentClass) => {
      const selected = selectPlaybook({ symbol, intent: "RECOMMEND" });
      expect(selected.exposure?.instrumentClass).toBe(instrumentClass);
      expect(selected.rules.some((rule) => rule.scope === "XAUUSD")).toBe(false);
      expect(selected.rules.some((rule) => rule.id === "FX.EXPOSURE")).toBe(false);
      expect(selected.rules.map((rule) => rule.id)).toContain("STRUCTURE.RECLAIM");
    },
  );

  it("uses a broker specification to classify an otherwise opaque symbol", () => {
    expect(
      instrumentExposure("BROKER-CRYPTO", { baseCurrency: "BTC", quoteCurrency: "USDT" })
        .instrumentClass,
    ).toBe("CRYPTO");
    expect(instrumentExposure("LISTED", { description: "Example share" }).instrumentClass).toBe(
      "EQUITY",
    );
  });

  it("does not give EURUSD any gold-only rule", () => {
    const selected = selectPlaybook({ symbol: "EURUSD", intent: "ANALYZE" });
    expect(selected.rules.some((rule) => rule.scope === "XAUUSD")).toBe(false);
    expect(selected.exposure?.currencies).toEqual(["EUR", "USD"]);
    expect(selected.macro.map((row) => row.bank)).toEqual(["ECB", "Federal Reserve"]);
  });

  it("maps GBPJPY to sterling and yen macro context", () => {
    const selected = selectPlaybook({ symbol: "GBPJPY.pro", news: "PRE" });
    expect(selected.exposure).toMatchObject({
      instrumentClass: "FX",
      currencies: ["GBP", "JPY"],
    });
    expect(selected.macro.map((row) => row.bank)).toEqual(["Bank of England", "Bank of Japan"]);
    expect(selected.rules.some((rule) => rule.scope === "XAUUSD")).toBe(false);
    expect(selected.rules.map((rule) => rule.id)).toContain("FX.EXPOSURE");
  });

  it("never carries a fixed gold-point distance into a rule", () => {
    const text = JSON.stringify(TRADING_PLAYBOOK);
    expect(text).not.toMatch(/gold points|30 points|60 points|100 points|150 points/i);
    const stop = TRADING_PLAYBOOK.find((rule) => rule.id === "NORM.ATR_STOP");
    expect(stop?.parameters.stop).toMatch(/ATR/);
    expect(instrumentExposure("EURUSD").instrumentClass).toBe("FX");
  });

  it("normalizes range and spread with the supplied instrument values", () => {
    expect(rangeMultiple("0.009", "0.003")).toBe("3");
    expect(spreadMultiple("0.0003", "0.0001")).toBe("3");
    expect(averageRange(["0.002", "0.004"], 2)).toBe("0.003");
    const candle = newsCandleEvidence({
      range: "0.009",
      atr: "0.003",
      spread: "0.0003",
      typicalSpread: "0.0001",
      ranges: ["0.002", "0.0021", "0.0019", "0.002", "0.0022"],
      candleTime: "2026-10-09T12:30:00.000Z",
      eventTime: "2026-10-09T12:30:10.000Z",
    });
    expect(candle.candidate).toBe(true);
    expect(candle.reasons).toContain("CALENDAR_ALIGNMENT");
    expect(candle.reasons).not.toContain("CERTAIN");
  });

  it("lets a news freeze and a risk denial outrank an entry heuristic", () => {
    expect(
      resolvePlaybookAction({
        riskDecision: "ALLOW",
        hasMandate: true,
        emergencyStop: false,
        newsFreeze: true,
        heuristic: "ENTER",
      }),
    ).toEqual({ outcome: "WAIT", precedence: "NEWS_PROTECTION" });
    expect(
      resolvePlaybookAction({
        riskDecision: "DENY",
        hasMandate: true,
        emergencyStop: false,
        newsFreeze: false,
        heuristic: "ENTER",
      }),
    ).toEqual({ outcome: "DENY", precedence: "RISK_ENGINE" });
  });

  it("keeps WAIT valid and refuses to invent a mandate", () => {
    expect(
      resolvePlaybookAction({
        riskDecision: "ALLOW",
        hasMandate: true,
        emergencyStop: false,
        newsFreeze: false,
        heuristic: "WAIT",
      }).outcome,
    ).toBe("WAIT");
    expect(
      resolvePlaybookAction({
        riskDecision: "ALLOW",
        hasMandate: false,
        emergencyStop: false,
        newsFreeze: false,
        heuristic: "ENTER",
      }),
    ).toEqual({ outcome: "WAIT", precedence: "NO_MANDATE" });
  });

  it("uses IANA session clocks rather than a fixed civil time", () => {
    const summer = tradingSessions(new Date("2026-07-15T12:30:00.000Z"));
    const winter = tradingSessions(new Date("2026-01-15T12:30:00.000Z"));
    expect(summer).toContain("LONDON");
    expect(summer).toContain("NEW_YORK");
    expect(winter).toContain("LONDON");
    expect(winter).not.toContain("NEW_YORK");
  });

  it("hides a disabled heuristic family and keeps safety rules", () => {
    const selected = selectPlaybook({
      symbol: "EURUSD",
      disabledGroups: ["xauusd-behavior", "retest"],
    });
    expect(selected.rules.some((rule) => rule.group === "retest")).toBe(false);
    expect(selected.rules.some((rule) => rule.id === "NEWS.FREEZE")).toBe(false);
    expect(
      selectPlaybook({
        symbol: "EURUSD",
        news: "PRE",
        disabledGroups: ["news-protocol"],
      }).rules.map((rule) => rule.id),
    ).toContain("NEWS.FREEZE");
  });
});

describe("scheduled news phase", () => {
  const at = (minutes: number) =>
    new Date(Date.parse("2026-10-09T12:30:00.000Z") + minutes * 60000);
  const event = (currency: string) => ({
    occursAt: "2026-10-09T12:30:00.000Z",
    impact: "HIGH" as const,
    currency,
  });
  it("maps the currency pair and leaves other currencies alone", () => {
    expect(newsPhaseForCurrencies([event("USD"), event("EUR")], ["EUR", "USD"], at(-10))).toBe(
      "PRE",
    );
    expect(newsPhaseForCurrencies([event("USD")], ["GBP", "JPY"], at(-10))).toBe("NONE");
    expect(newsPhaseForCurrencies([event("USD")], ["XAU", "USD"], at(0))).toBe("RELEASE");
    expect(newsPhaseForCurrencies([event("USD")], ["EUR", "USD"], at(10))).toBe("POST");
    expect(newsPhaseForCurrencies([], ["EUR", "USD"], at(-10))).toBe("NONE");
    expect(
      newsPhaseForCurrencies([{ ...event("USD"), impact: "LOW" }], ["EUR", "USD"], at(-10)),
    ).toBe("NONE");
  });
  it("lets that phase override an entry heuristic", () => {
    expect(
      resolvePlaybookAction({
        riskDecision: "ALLOW",
        hasMandate: true,
        emergencyStop: false,
        newsFreeze: newsPhaseForCurrencies([event("EUR")], ["EUR", "USD"], at(-5)) !== "NONE",
        heuristic: "ENTER",
      }).precedence,
    ).toBe("NEWS_PROTECTION");
  });
});

describe("playbook measurements", () => {
  it("scores an outlier range and a candle body exactly", () => {
    const score = zScore(["1", "1.1", "0.9", "1", "1.2", "4"]);
    expect(score).not.toBeNull();
    expect(financialUnits(score!)).toBeGreaterThan(0n);
    expect(bodyRangeRatio({ open: "10", high: "12", low: "9", close: "11.6" })).toBe(
      "0.533333333333",
    );
  });
});
