import { describe, expect, it } from "vitest";
import { financialResearchUrlAllowed } from "./financial-egress-policy.js";

describe("trading research egress policy", () => {
  it.each([
    "https://www.reuters.com/markets/currencies/",
    "https://www.forexfactory.com/calendar",
    "https://www.ecb.europa.eu/press/pr/html/index.en.html",
    "https://fred.stlouisfed.org/series/DGS10",
    "https://html.duckduckgo.com/html/?q=EURUSD+CPI",
    "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1h",
    "https://metaapi.cloud/docs/client/",
    "http://example.org/",
    "https://objects.githubusercontent.com/release.tar.gz?X-Amz-Signature=abc",
  ])("allows anonymous public research %s", (url) => {
    expect(financialResearchUrlAllowed(url)).toBe(true);
    expect(financialResearchUrlAllowed(url, "HEAD")).toBe(true);
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT"])("never allows %s", (method) => {
    expect(financialResearchUrlAllowed("https://www.reuters.com/", method)).toBe(false);
  });
  it.each([
    "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/a/trade",
    "https://mt-provisioning-api-v1.agiliumtrade.agiliumlabs.cloud/users/current/accounts",
    "https://trade.mql5.com/trade",
    "https://api-fxtrade.oanda.com/v3/accounts",
    "https://paper-api.alpaca.markets/v2/orders",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://supervisor:7091/computers",
    "http://postgres/",
    "http://printer.local/",
    "https://router.home.arpa/",
    "https://www.reuters.com:8443/",
    "http://www.reuters.com:443/",
    "ftp://ftp.example.org/file",
    "file:///etc/passwd",
    "https://user:pass@www.reuters.com/",
    "https://news.example.org/feed?apiKey=sentinel",
    "https://news.example.org/feed?access_token=sentinel",
    "https://news.example.org/feed?token=sentinel",
    "https://news.example.org/feed?client_secret=sentinel",
    `https://www.reuters.com/${"a".repeat(8200)}`,
    "not a url",
  ])("refuses financial, internal, authenticated or opaque destination %s", (url) => {
    expect(financialResearchUrlAllowed(url)).toBe(false);
  });
});
