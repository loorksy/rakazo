import { type InstrumentClass, instrumentExposure } from "./trading-playbook.js";

/** How long a persisted broker directory can answer search without a provider refresh. */
export const INSTRUMENT_DIRECTORY_FRESH_MS = 15 * 60 * 1000;

export interface BrokerDirectoryRecord {
  id: string;
  accountId: string;
  brokerSymbol: string;
  displayName: string;
  verifiedAt: string | null;
  specification?: {
    baseCurrency?: string | null;
    quoteCurrency?: string | null;
    description?: string | null;
  } | null;
}

export interface InstrumentSearchMatch {
  instrumentId: string;
  brokerSymbol: string;
  displayName: string;
  accountId: string;
  instrumentClass: InstrumentClass;
  verifiedAt: string | null;
}

export interface InstrumentSearchResult {
  accountId: string;
  query: string;
  matches: InstrumentSearchMatch[];
  ambiguous: boolean;
  fresh: boolean;
  syncedAt: string | null;
  directoryCount: number;
  unavailable: boolean;
  message: string | null;
  provenance: {
    source: "broker";
    provider: string;
    accountId: string;
    instrumentId: string | null;
    brokerSymbol: string | null;
    supplementary: false;
  };
}

interface Alias {
  phrases: string[];
  tokens: string[];
}

/** Natural-language hints. They never name an execution symbol. */
const ALIASES: Alias[] = [
  { phrases: ["bitcoin", "بيتكوين"], tokens: ["BTC"] },
  { phrases: ["ethereum", "ether"], tokens: ["ETH"] },
  { phrases: ["gold", "ذهب"], tokens: ["XAU", "GOLD"] },
  { phrases: ["silver", "فضة"], tokens: ["XAG", "SILVER"] },
  { phrases: ["oil", "crude", "نفط"], tokens: ["USOIL", "UKOIL", "WTI", "BRENT", "XTI", "XBR"] },
  { phrases: ["nasdaq", "nas100", "ustec"], tokens: ["NAS100", "USTEC", "US100", "NASDAQ"] },
  { phrases: ["dow", "us30"], tokens: ["US30", "DJ30"] },
  { phrases: ["dax", "ger40"], tokens: ["GER40", "DE40", "DAX"] },
  { phrases: ["pound yen", "gbpjpy", "gbp/jpy"], tokens: ["GBP", "JPY"] },
  { phrases: ["euro dollar", "eurusd", "eur/usd"], tokens: ["EUR", "USD"] },
  { phrases: ["pound dollar", "gbpusd", "gbp/usd"], tokens: ["GBP", "USD"] },
];

function mentions(query: string, phrase: string): boolean {
  if ([...phrase].some((character) => character.charCodeAt(0) > 127)) return query.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(query);
}

function queryTokens(query: string): { hints: string[]; compact: string } {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  const hints = new Set<string>();
  for (const alias of ALIASES) {
    if (!alias.phrases.some((phrase) => mentions(normalized, phrase))) continue;
    for (const token of alias.tokens) hints.add(token);
  }
  const compact = normalized.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return {
    hints: [...hints],
    compact: compact.length >= 2 && compact.length <= 32 ? compact : "",
  };
}

function quoteRank(currencies: string[]): number {
  const quote = currencies[1] ?? "";
  if (quote === "USDT") return 0;
  if (quote === "USD") return 1;
  if (quote === "USDC") return 2;
  return 3;
}

function scoreRecord(record: BrokerDirectoryRecord, hints: string[], compact: string): number {
  const exposure = instrumentExposure(record.brokerSymbol, record.specification ?? undefined);
  const symbol = record.brokerSymbol.toUpperCase();
  const letters = symbol.replace(/[^A-Z0-9]/g, "");
  const display = record.displayName.toLowerCase();
  const currencies = new Set(exposure.currencies);
  let best = 0;
  if (compact && (symbol === compact || letters === compact)) best = 100;
  else if (compact && (exposure.root === compact || letters.startsWith(compact))) best = 84;
  if (hints.length >= 2 && hints.every((token) => currencies.has(token))) best = Math.max(best, 90);
  for (const token of [...hints, compact].filter((token) => token.length > 0)) {
    if (exposure.currencies[0] === token || exposure.root === token || letters.startsWith(token)) {
      const quote = exposure.currencies[1] ?? "";
      const bonus = quote === "USD" || quote === "USDT" || quote === "USDC" ? 8 : 0;
      best = Math.max(best, 70 + bonus);
    }
    if (token.length >= 3 && display.includes(token.toLowerCase())) best = Math.max(best, 60);
  }
  return best;
}

export function instrumentDirectoryFresh(syncedAt: Date | null, now: Date): boolean {
  if (!syncedAt) return false;
  const age = now.getTime() - syncedAt.getTime();
  return age >= -2000 && age < INSTRUMENT_DIRECTORY_FRESH_MS;
}

/** Rank a persisted directory. The result never invents a symbol that is not in `records`. */
export function searchBrokerDirectory(input: {
  accountId: string;
  provider: string;
  query: string;
  records: BrokerDirectoryRecord[];
  limit?: number;
  fresh: boolean;
  syncedAt: string | null;
  unavailable?: boolean;
}): InstrumentSearchResult {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);
  const tokens = queryTokens(input.query);
  const ranked = input.records
    .map((record) => ({ record, score: scoreRecord(record, tokens.hints, tokens.compact) }))
    .filter((item) => item.score >= 60)
    .sort(
      (left, right) =>
        right.score - left.score ||
        quoteRank(
          instrumentExposure(left.record.brokerSymbol, left.record.specification ?? undefined)
            .currencies,
        ) -
          quoteRank(
            instrumentExposure(right.record.brokerSymbol, right.record.specification ?? undefined)
              .currencies,
          ) ||
        left.record.brokerSymbol.localeCompare(right.record.brokerSymbol),
    )
    .slice(0, limit);
  const matches = ranked.map(({ record }) => ({
    instrumentId: record.id,
    brokerSymbol: record.brokerSymbol,
    displayName: record.displayName,
    accountId: record.accountId,
    instrumentClass: instrumentExposure(record.brokerSymbol, record.specification ?? undefined)
      .instrumentClass,
    verifiedAt: record.verifiedAt,
  }));
  const ambiguous = ranked.length > 1 && ranked[1]!.score >= ranked[0]!.score - 5;
  const unavailable = input.unavailable === true || input.records.length === 0;
  const first = matches[0];
  return {
    accountId: input.accountId,
    query: input.query,
    matches: unavailable ? [] : matches,
    ambiguous: unavailable ? false : ambiguous,
    fresh: input.fresh,
    syncedAt: input.syncedAt,
    directoryCount: input.records.length,
    unavailable,
    message: unavailable
      ? "Broker-native instrument directory is temporarily unavailable."
      : matches.length === 0
        ? "No broker instrument matched this query."
        : ambiguous
          ? "Multiple broker instruments match. Select the exact brokerSymbol."
          : null,
    provenance: {
      source: "broker",
      provider: input.provider,
      accountId: input.accountId,
      instrumentId: unavailable ? null : (first?.instrumentId ?? null),
      brokerSymbol: unavailable ? null : (first?.brokerSymbol ?? null),
      supplementary: false,
    },
  };
}
