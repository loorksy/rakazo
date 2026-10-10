import { PlaybookGroupIdSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { financialUnits } from "./financial-decimal.js";
import {
  averageRange,
  bodyRangeRatio,
  instrumentExposure,
  macroExposure,
  newsCandleEvidence,
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
