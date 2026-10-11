import { describe, expect, it } from "vitest";
import {
  type BrokerDirectoryRecord,
  instrumentDirectoryFresh,
  searchBrokerDirectory,
} from "./broker-instrument-search.js";
import { selectPlaybook } from "./trading-playbook.js";

function row(brokerSymbol: string, displayName = brokerSymbol): BrokerDirectoryRecord {
  return {
    id: `id-${brokerSymbol}`,
    accountId: "account",
    brokerSymbol,
    displayName,
    verifiedAt: "2026-10-11T00:00:00.000Z",
  };
}

const directory = [
  row("EURUSDm", "Euro"),
  row("GBPJPYraw", "Pound yen"),
  row("XAUUSDm", "Gold"),
  row("XAUUSD247m", "Gold 247"),
  row("BTCUSDTm", "Bitcoin"),
  row("BTCUSDm", "Bitcoin USD"),
  row("BTCAUDm", "Bitcoin AUD"),
  row("NAS100", "Nasdaq"),
  row("USOIL", "Oil"),
  row("USTECm", "US Tech"),
];

function search(query: string) {
  return searchBrokerDirectory({
    accountId: "account",
    provider: "metaapi",
    query,
    records: directory,
    fresh: true,
    syncedAt: "2026-10-11T00:00:00.000Z",
  });
}

describe("broker instrument search", () => {
  it.each([
    ["EURUSD", "EURUSDm", "FX"],
    ["EUR/USD", "EURUSDm", "FX"],
    ["pound yen", "GBPJPYraw", "FX"],
    ["GBP/JPY", "GBPJPYraw", "FX"],
    ["بيتكوين", "BTCUSDTm", "CRYPTO"],
    ["bitcoin", "BTCUSDTm", "CRYPTO"],
    ["nasdaq", "NAS100", "INDEX"],
    ["NAS100", "NAS100", "INDEX"],
  ] as const)("resolves %s to the persisted broker symbol %s", (query, symbol, instrumentClass) => {
    const result = search(query);
    expect(result.unavailable).toBe(false);
    expect(result.matches[0]).toMatchObject({
      brokerSymbol: symbol,
      instrumentId: `id-${symbol}`,
      accountId: "account",
      instrumentClass,
    });
    expect(result.provenance.source).toBe("broker");
    if (result.ambiguous) expect(result.primary).toBeNull();
    else expect(result.primary?.brokerSymbol).toBe(symbol);
    expect(result.matches.map((match) => match.brokerSymbol)).not.toContain("BTCUSDT");
    expect(JSON.stringify(result)).not.toContain("binance");
  });

  it("keeps an exact decorated symbol and asks when gold is ambiguous", () => {
    expect(search("EURUSDm").ambiguous).toBe(false);
    expect(search("EURUSDm").matches.map((match) => match.brokerSymbol)).toEqual(["EURUSDm"]);
    const gold = search("ذهب");
    expect(gold.ambiguous).toBe(true);
    expect(gold.matches.map((match) => match.brokerSymbol)).toEqual(
      expect.arrayContaining(["XAUUSDm", "XAUUSD247m"]),
    );
    expect(gold.message).toContain("exact brokerSymbol");
  });

  it("finds oil without substituting another venue", () => {
    const oil = search("oil");
    expect(oil.matches.map((match) => match.brokerSymbol)).toContain("USOIL");
    expect(oil.matches.every((match) => match.brokerSymbol !== "BTCUSDTm")).toBe(true);
  });

  it("does not dump the directory when the broker directory is empty", () => {
    const result = searchBrokerDirectory({
      accountId: "account",
      provider: "metaapi",
      query: "EURUSD",
      records: [],
      fresh: false,
      syncedAt: null,
      unavailable: true,
    });
    expect(result.matches).toEqual([]);
    expect(result.unavailable).toBe(true);
    expect(result.message).toBe("Broker-native instrument directory is temporarily unavailable.");
    expect(result.directoryCount).toBe(0);
  });

  it("treats a recent directory timestamp as fresh", () => {
    const now = new Date("2026-10-11T00:10:00.000Z");
    expect(instrumentDirectoryFresh(new Date("2026-10-11T00:00:00.000Z"), now)).toBe(true);
    expect(instrumentDirectoryFresh(new Date("2026-10-10T00:00:00.000Z"), now)).toBe(false);
    expect(instrumentDirectoryFresh(null, now)).toBe(false);
  });

  it("selects class context for the same symbols the search returns", () => {
    for (const [symbol, scope, absent] of [
      ["EURUSDm", "FX", "XAU.SAFE_HAVEN"],
      ["GBPJPYraw", "FX", "XAU.SAFE_HAVEN"],
      ["XAUUSDm", "XAUUSD", "FX.EXPOSURE"],
      ["BTCUSDTm", "CRYPTO", "FX.EXPOSURE"],
      ["NAS100", "INDEX", "FX.EXPOSURE"],
      ["USOIL", "ENERGY", "XAU.SAFE_HAVEN"],
    ] as const) {
      const selected = selectPlaybook({ symbol, intent: "RECOMMEND" });
      expect(selected.rules.some((rule) => rule.scope === scope || rule.id.startsWith(scope))).toBe(
        true,
      );
      expect(selected.rules.map((rule) => rule.id)).not.toContain(absent);
      expect(selected.rules.map((rule) => rule.id)).toContain("STRUCTURE.RECLAIM");
    }
    expect(
      selectPlaybook({ symbol: "BTCUSDTm" }).rules.some((rule) => rule.scope === "XAUUSD"),
    ).toBe(false);
    expect(selectPlaybook({ symbol: "USTECm" }).exposure?.instrumentClass).toBe("INDEX");
  });
});
