import { financialDecimal, financialUnits } from "./financial-decimal.js";

/** Shared product knowledge. Not a Bot prompt and not financial authority. */
export const TRADING_PLAYBOOK_VERSION = "2026.10.10";

export const PLAYBOOK_INTENTS = ["ANALYZE", "RECOMMEND", "MONITOR", "MANAGE"] as const;
export type PlaybookIntent = (typeof PLAYBOOK_INTENTS)[number];
export type PlaybookScope = "UNIVERSAL" | "NORMALIZED" | "FX" | "XAUUSD";
export type PlaybookNews = "NONE" | "PRE" | "RELEASE" | "POST" | "UNSCHEDULED" | "ANY";

export interface PlaybookRule {
  id: string;
  category: string;
  /** Owner-toggleable heuristic family. Safety rules have none and cannot be disabled. */
  group: string | null;
  scope: PlaybookScope;
  /** Empty means every instrument in the scope. */
  currencies: string[];
  timeframes: string[];
  sessions: string[];
  news: PlaybookNews;
  intents: PlaybookIntent[];
  priority: number;
  classification: "HEURISTIC" | "SAFETY";
  /** Instrument-normalized parameters. Never a fixed gold-point distance. */
  parameters: Record<string, string>;
  guidance: string;
}

export interface InstrumentExposure {
  /** Broker root symbol, suffixes removed. The broker symbol stays authoritative for execution. */
  root: string;
  instrumentClass: "FX" | "METAL" | "OTHER";
  currencies: string[];
  themes: string[];
}

const CURRENCY_CONTEXT: Record<string, { bank: string; releases: string; themes: string[] }> = {
  USD: {
    bank: "Federal Reserve",
    releases: "CPI, NFP, FOMC, PPI, jobless claims, retail sales",
    themes: ["usd", "yields"],
  },
  EUR: { bank: "ECB", releases: "ECB rate decision, eurozone CPI, PMI", themes: ["eur"] },
  GBP: { bank: "Bank of England", releases: "BoE rate decision, UK CPI, UK GDP", themes: ["gbp"] },
  JPY: {
    bank: "Bank of Japan",
    releases: "BoJ decision, Tokyo CPI, intervention risk",
    themes: ["jpy", "safe-haven"],
  },
  CHF: { bank: "Swiss National Bank", releases: "SNB decision", themes: ["chf", "safe-haven"] },
  AUD: {
    bank: "Reserve Bank of Australia",
    releases: "RBA decision, employment, China and commodity context",
    themes: ["aud", "commodity"],
  },
  NZD: { bank: "Reserve Bank of New Zealand", releases: "RBNZ decision", themes: ["nzd"] },
  CAD: {
    bank: "Bank of Canada",
    releases: "BoC decision, employment, oil context",
    themes: ["cad", "commodity"],
  },
  CNH: { bank: "People's Bank of China", releases: "CNY fixing, PMI", themes: ["cnh"] },
  XAU: {
    bank: "no central bank",
    releases: "US yields, Fed policy, real rates",
    themes: ["gold", "safe-haven", "yields"],
  },
  XAG: { bank: "no central bank", releases: "metals and growth context", themes: ["silver"] },
};

/** Known quote currencies, longest first so metal prefixes win over FX slicing. */
const METALS: Record<string, { currencies: string[]; themes: string[] }> = {
  XAU: { currencies: ["XAU", "USD"], themes: ["gold", "safe-haven", "yields"] },
  GOLD: { currencies: ["XAU", "USD"], themes: ["gold", "safe-haven", "yields"] },
  XAG: { currencies: ["XAG", "USD"], themes: ["silver", "metals"] },
  SILVER: { currencies: ["XAG", "USD"], themes: ["silver", "metals"] },
};

const PAIR_CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "CNH", "XAU", "XAG"];
/** Short broker decorations around a pair. Not a list of tradable symbols. */
const AFFIXES = new Set([
  "",
  "M",
  "I",
  "R",
  "S",
  "X",
  "Z",
  "FX",
  "SB",
  "PRO",
  "RAW",
  "ECN",
  "CASH",
  "SPOT",
  "MICRO",
  "MINI",
]);

function normalizeCurrency(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  if (code === "GOLD") return "XAU";
  if (code === "SILVER") return "XAG";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function fromPair(root: string, base: string, quote: string): InstrumentExposure {
  const metal = METALS[base] ?? (base === "XAU" || base === "XAG" ? METALS[base] : undefined);
  if (metal || base === "XAU" || base === "XAG") {
    const currencies = base === "XAG" || base === "SILVER" ? ["XAG", quote] : ["XAU", quote];
    return {
      root,
      instrumentClass: "METAL",
      currencies,
      themes: [
        ...new Set([
          ...(metal?.themes ?? ["safe-haven"]),
          ...(CURRENCY_CONTEXT[quote]?.themes ?? []),
        ]),
      ],
    };
  }
  return {
    root,
    instrumentClass: "FX",
    currencies: [base, quote],
    themes: [...(CURRENCY_CONTEXT[base]?.themes ?? []), ...(CURRENCY_CONTEXT[quote]?.themes ?? [])],
  };
}

/**
 * Knowledge classification only. The broker symbol passed to execution is never rewritten.
 * A verified base/quote from the broker specification wins. Otherwise a known pair is read
 * from inside a short prefix or suffix; an ambiguous string stays unclassified.
 */
export function instrumentExposure(
  symbol: string,
  specification?: { baseCurrency?: string | null; quoteCurrency?: string | null },
): InstrumentExposure {
  const root = symbol.split(/[^A-Za-z0-9]/)[0]?.toUpperCase() ?? "";
  const specifiedBase = normalizeCurrency(specification?.baseCurrency);
  const specifiedQuote = normalizeCurrency(specification?.quoteCurrency);
  if (specifiedBase && specifiedQuote)
    return fromPair(root || symbol.toUpperCase(), specifiedBase, specifiedQuote);
  const letters = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  const matches: Array<{ base: string; quote: string; affix: string }> = [];
  for (let index = 0; index + 6 <= letters.length; index++) {
    const base = letters.slice(index, index + 3);
    const quote = letters.slice(index + 3, index + 6);
    if (!PAIR_CODES.includes(base) || !PAIR_CODES.includes(quote) || base === quote) continue;
    const affix = `${letters.slice(0, index)} ${letters.slice(index + 6)}`;
    const [prefix, suffix] = affix.split(" ");
    if (AFFIXES.has(prefix ?? "") && AFFIXES.has(suffix ?? ""))
      matches.push({ base, quote, affix });
  }
  if (letters.startsWith("GOLD") && AFFIXES.has(letters.slice(4)))
    return fromPair(root || letters, "XAU", "USD");
  if (letters.startsWith("SILVER") && AFFIXES.has(letters.slice(6)))
    return fromPair(root || letters, "XAG", "USD");
  const unique = [
    ...new Map(matches.map((match) => [`${match.base}${match.quote}`, match])).values(),
  ];
  if (unique.length === 1) return fromPair(root || letters, unique[0]!.base, unique[0]!.quote);
  return { root: root || letters, instrumentClass: "OTHER", currencies: [], themes: [] };
}

const NEWS_PRE_MS = 15 * 60 * 1000;
const NEWS_RELEASE_MS = 60 * 1000;
const NEWS_POST_MS = 30 * 60 * 1000;
const NEWS_RANK: Record<PlaybookNews, number> = {
  NONE: 0,
  ANY: 0,
  UNSCHEDULED: 0,
  POST: 1,
  PRE: 2,
  RELEASE: 3,
};

export interface ScheduledEventPhase {
  occursAt: string;
  impact: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  currency: string;
}

/** High-impact events for these currencies only. No event list means no phase, never a guessed one. */
export function newsPhaseForCurrencies(
  events: ScheduledEventPhase[],
  currencies: string[],
  now: Date,
): PlaybookNews {
  const wanted = new Set(currencies);
  let phase: PlaybookNews = "NONE";
  for (const event of events) {
    if (event.impact !== "HIGH" || !wanted.has(event.currency)) continue;
    const at = Date.parse(event.occursAt);
    if (!Number.isFinite(at)) continue;
    const delta = now.getTime() - at;
    const next: PlaybookNews =
      delta >= -NEWS_PRE_MS && delta < 0
        ? "PRE"
        : delta >= 0 && delta <= NEWS_RELEASE_MS
          ? "RELEASE"
          : delta > NEWS_RELEASE_MS && delta <= NEWS_POST_MS
            ? "POST"
            : "NONE";
    if (NEWS_RANK[next] > NEWS_RANK[phase]) phase = next;
  }
  return phase;
}

export function macroExposure(
  symbol: string,
  specification?: { baseCurrency?: string | null; quoteCurrency?: string | null },
) {
  const exposure = instrumentExposure(symbol, specification);
  return exposure.currencies.map((currency) => ({
    currency,
    ...(CURRENCY_CONTEXT[currency] ?? {
      bank: "unlisted",
      releases: "use the instrument's own calendar",
      themes: [],
    }),
  }));
}

const UNIVERSAL: PlaybookRule[] = [
  rule("STRUCTURE.RECLAIM", "structure", "entry-timing", "UNIVERSAL", {
    priority: 40,
    guidance:
      "A break of a level followed by a close back through it is a reclaim candidate. Treat it as evidence of rejection, not as an order.",
  }),
  rule("STRUCTURE.ROLE_REVERSAL", "structure", "entry-timing", "UNIVERSAL", {
    priority: 30,
    guidance:
      "A broken level can act as the opposite side only when the reaction is prompt and a rejection candle forms. A slow grind through it weakens that reading.",
  }),
  rule("STRUCTURE.CONFLUENCE", "structure", "entry-timing", "UNIVERSAL", {
    priority: 35,
    guidance:
      "Where a trendline, a horizontal level and a measured retracement meet, treat the zone as higher-quality context than any one of them.",
  }),
  rule("STRUCTURE.FAILED_PATTERN", "structure", "entry-timing", "UNIVERSAL", {
    priority: 30,
    guidance:
      "A pattern that fails and closes through its invalidation is evidence for the opposite direction. It does not require a new touch of the old level.",
  }),
  rule("STRUCTURE.RANGE_EXHAUSTION", "structure", "entry-timing", "UNIVERSAL", {
    parameters: { threshold: "about 1.5 × recent average daily range" },
    guidance:
      "After a session extends well beyond its recent average daily range, continuation is a weaker prior and the first reversal candle is the relevant evidence.",
  }),
  rule("LIQUIDITY.STOP_POOLS", "liquidity", "entry-timing", "UNIVERSAL", {
    priority: 45,
    guidance:
      "Equal highs and lows attract wicks. A stop sitting directly beyond them is more likely to be traded through than one placed beyond the pool with a volatility buffer.",
  }),
  rule("LIQUIDITY.SWEEP", "liquidity", "entry-timing", "UNIVERSAL", {
    guidance:
      "A sweep of a session extreme followed by a return inside the range is evidence of a liquidity run, not by itself a completed entry.",
  }),
  rule("RETEST.NOT_REQUIRED", "retest", "retest", "UNIVERSAL", {
    priority: 40,
    guidance:
      "A strong break can continue without revisiting the broken level. Waiting for a retest is a choice, and it can miss the move.",
  }),
  rule("RETEST.ZONE", "retest", "retest", "UNIVERSAL", {
    parameters: { zone: "a band of several spreads or a fraction of ATR, not one price" },
    guidance:
      "Treat a retest as a price band sized from current spread and ATR. A single printed price is a poor stand-in for the zone.",
  }),
  rule("RETEST.REJECTION", "retest", "retest", "UNIVERSAL", {
    guidance:
      "A touch of a broken level is not a retest entry. Look for a fast rejection wick or an engulfing candle; a full body settling on the level is evidence the break is failing.",
  }),
  rule("RETEST.FAILED", "retest", "retest", "UNIVERSAL", {
    parameters: { invalidation: "retracement beyond about 78.6% of the break impulse" },
    guidance:
      "If price cannot hold the retest and the pullback consumes most of the break impulse, cancel the continuation idea.",
  }),
  rule("RETEST.REPEATED", "retest", "retest", "UNIVERSAL", {
    parameters: { weakening: "a third return to the same level" },
    guidance:
      "Repeated tests of one level tend to exhaust the defending side. Later tests are weaker evidence of continuation.",
  }),
  rule("TREND.STEEPEST", "trend", "trendline", "UNIVERSAL", {
    guidance:
      "In an accelerating move, the steeper nearby trendline is the relevant one. A break of it is a warning, not automatically a reversal.",
  }),
  rule("TREND.THIRD_TOUCH", "trend", "trendline", "UNIVERSAL", {
    guidance:
      "A third touch of a trendline is often the cleanest reaction. Fourth and later touches carry a higher break risk and deserve less confidence.",
  }),
  rule("TREND.WICK_CLOSE", "trend", "trendline", "UNIVERSAL", {
    guidance:
      "A wick through a trendline that closes back inside is a candidate to redraw the line, not a completed break. Prefer closes over wicks for the break decision.",
  }),
  rule("CANDLE.BODY", "candle", "candle", "UNIVERSAL", {
    parameters: { conviction: "body near 70–80% of the candle range" },
    guidance:
      "A small body through a level is weak evidence of a break. A body that is most of the range is stronger evidence of control.",
  }),
  rule("CANDLE.DOJI", "candle", "candle", "UNIVERSAL", {
    guidance:
      "A doji is indecision, not a reversal command. Direction still depends on the level and the next close.",
  }),
  rule("CANDLE.LOCATION", "candle", "candle", "UNIVERSAL", {
    guidance:
      "A hammer or pin bar away from a level or liquidity pool is weak evidence. The same candle at a real level is more informative.",
  }),
  rule("CANDLE.EXHAUSTION_SEQUENCE", "candle", "candle", "UNIVERSAL", {
    parameters: {
      stretch: "about five consecutive closes in one direction on the traded timeframe",
    },
    guidance:
      "A long unbroken sequence of same-direction candles raises the chance of a pause. Chasing the last one is a weaker idea than waiting.",
  }),
  rule("CANDLE.CLOSE_LOCATION", "candle", "candle", "UNIVERSAL", {
    parameters: { control: "close in the outer quarter of the range" },
    guidance:
      "A close near the extreme of its own range is evidence that one side held control into the close, even if the other wick is long.",
  }),
  rule("STOP.INVALIDATION", "risk", "execution", "UNIVERSAL", {
    priority: 60,
    classification: "SAFETY",
    group: null,
    guidance:
      "A stop belongs where the idea is invalidated, beyond the liquidity pool, sized from ATR and spread. A fixed point distance is not a stop.",
  }),
  rule("STOP.NO_WIDEN", "risk", "execution", "UNIVERSAL", {
    priority: 80,
    classification: "SAFETY",
    group: null,
    guidance:
      "Do not widen a stop after entry to accept a larger loss. Tightening behind new structure is a reduction; widening is new risk and needs fresh authority.",
  }),
  rule("STOP.BUFFER", "risk", "execution", "UNIVERSAL", {
    parameters: { buffer: "a multiple of current spread and a fraction of ATR, past the pool" },
    guidance:
      "Place the stop beyond the liquidity pool by a buffer derived from spread and ATR, not on the pool itself and not on a round number.",
  }),
  rule("TARGET.PARTIAL", "targets", "targets", "UNIVERSAL", {
    parameters: { firstScale: "near 1R, then protect the remainder" },
    guidance:
      "Taking a portion off near one times the initial risk and protecting the rest is a common way to keep a runner without giving the trade back. It is a plan, not a guarantee.",
  }),
  rule("TARGET.STRUCTURE", "targets", "targets", "UNIVERSAL", {
    guidance:
      "Targets can be the opposing liquidity, a channel boundary, or an ATR multiple. They do not have to be the next horizontal line.",
  }),
  rule("TARGET.SPREAD", "targets", "targets", "UNIVERSAL", {
    guidance:
      "A target should clear the spread and expected slippage by enough to keep the planned reward. If it does not, the idea is weaker than it looks.",
  }),
  rule("EXECUTION.WAIT", "execution", "execution", "UNIVERSAL", {
    priority: 70,
    classification: "SAFETY",
    group: null,
    guidance:
      "When signals conflict or visibility is poor, WAIT is a complete decision. No heuristic requires a trade.",
  }),
  rule("EXECUTION.FRESHNESS", "execution", "execution", "UNIVERSAL", {
    priority: 80,
    classification: "SAFETY",
    group: null,
    parameters: { quoteAge: "a few seconds; stale quotes cancel execution" },
    guidance:
      "Do not send an order on a stale quote or a stale account snapshot. Freshness is a hard condition, not a judgment call.",
  }),
  rule("EXECUTION.RR", "execution", "execution", "UNIVERSAL", {
    parameters: { floor: "about 1.5 reward per unit of risk after spread" },
    guidance:
      "If price has already moved so far that the remaining reward no longer clears the planned risk by a comfortable margin, cancel rather than chase.",
  }),
  rule("EXECUTION.NO_REVENGE", "execution", "execution", "UNIVERSAL", {
    priority: 60,
    classification: "SAFETY",
    group: null,
    guidance:
      "After consecutive losses, pause new risk. A heuristic that says enter does not override a cool-down or a daily loss limit.",
  }),
  rule("VOLATILITY.LOT", "volatility", "execution", "UNIVERSAL", {
    parameters: { size: "inverse to ATR, inside the mandate and account limits" },
    guidance:
      "When realized volatility expands, smaller size keeps the same risk. Doubling down as volatility rises is not part of this playbook.",
  }),
];

const NORMALIZED: PlaybookRule[] = [
  rule("NORM.SPREAD_KILL", "execution", null, "NORMALIZED", {
    priority: 90,
    classification: "SAFETY",
    parameters: { kill: "spread above about 3× its recent typical value" },
    guidance:
      "Stop new execution when the spread is several times its recent typical value, and wait until it has settled. The threshold is the instrument's own spread, not a gold-point constant.",
  }),
  rule("NORM.SLIPPAGE", "execution", null, "NORMALIZED", {
    priority: 85,
    classification: "SAFETY",
    parameters: { tolerance: "a small multiple of the typical spread" },
    guidance:
      "Reject a market execution whose expected slippage exceeds a small multiple of the typical spread. Do not reuse a fixed gold-point tolerance.",
  }),
  rule("NORM.ATR_STOP", "risk", "execution", "NORMALIZED", {
    parameters: { stop: "beyond structure by a fraction of ATR plus the spread buffer" },
    guidance:
      "Express stop distance in ATR and spread for this symbol's tick size and digits. A fixed distance taken from another market does not transfer.",
  }),
  rule("NORM.ADR", "volatility", "execution", "NORMALIZED", {
    parameters: { extension: "percent of this symbol's average daily range" },
    guidance:
      "Judge whether the day is extended by this symbol's own average daily range. A quiet day for one market is a full day for another.",
  }),
  rule("NORM.SESSION", "session", "execution", "NORMALIZED", {
    guidance:
      "Session opens, rollover and the daily close are instrument-specific clocks. Use the venue's IANA timezone, not a fixed civil time from another city.",
  }),
];

const FX: PlaybookRule[] = [
  rule("FX.EXPOSURE", "macro", "news-protocol", "FX", {
    priority: 50,
    guidance:
      "Map scheduled news to both currencies. A USD event and a base-currency central-bank event can both dominate; neither is optional context.",
  }),
  rule("FX.CONFLICT", "macro", "news-protocol", "FX", {
    priority: 55,
    news: "RELEASE",
    guidance:
      "When two releases in the same print point opposite ways, treat the moment as conflicted and prefer WAIT over a directional heuristic.",
  }),
  rule("FX.PRICED_IN", "macro", "news-protocol", "FX", {
    news: "PRE",
    guidance:
      "A large directional move in the hours before a release is evidence the result may already be priced. The release itself can then reverse on profit-taking.",
  }),
];

const GOLD: PlaybookRule[] = [
  rule("XAU.SAFE_HAVEN", "intermarket", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    priority: 40,
    guidance:
      "In a confirmed geopolitical or banking shock, gold can rise with the dollar. The usual inverse dollar relationship is a prior, not a rule, in that regime.",
  }),
  rule("XAU.YIELDS", "intermarket", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    guidance:
      "A sustained rise in real yields is a headwind for gold on higher timeframes. A single candle against that backdrop is weaker evidence.",
  }),
  rule("XAU.SILVER_LEAD", "intermarket", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    guidance:
      "When silver breaks a comparable high while gold has not, that is a candidate leading indication for gold. It is not a certainty that gold follows.",
  }),
  rule("XAU.ASIA_SWEEP", "liquidity", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    sessions: ["LONDON_OPEN"],
    guidance:
      "Gold often runs the Asia-session high or low around the London open and then reverses. Treat that as a gold-specific prior, not as a fact about other pairs.",
  }),
  rule("XAU.FIXING", "session", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    parameters: { window: "London afternoon gold fixing, Europe/London" },
    guidance:
      "The London gold fixing window can bring abrupt flows in spot gold. Do not apply that clock to FX pairs.",
  }),
  rule("XAU.DEEP_RETRACEMENT", "retest", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    parameters: { prior: "deeper than the 50–61.8% area often watched on FX" },
    guidance:
      "Gold corrections often run deeper than the retracements traders expect on currencies. Do not copy that depth onto EURUSD or other pairs.",
  }),
];

const NEWS: PlaybookRule[] = [
  rule("NEWS.FREEZE", "news", null, "UNIVERSAL", {
    priority: 95,
    classification: "SAFETY",
    news: "PRE",
    parameters: { window: "about 15 minutes before a high-impact release" },
    guidance:
      "Do not open new risk in the window before a high-impact release. This freeze overrides an ordinary momentum or reclaim entry.",
  }),
  rule("NEWS.PULL_PENDINGS", "news", null, "UNIVERSAL", {
    priority: 95,
    classification: "SAFETY",
    news: "PRE",
    guidance:
      "Cancel pending entries before a high-impact release so a spread spike cannot fill them. This does not cancel a protective stop on an open position.",
  }),
  rule("NEWS.FIRST_MINUTE", "news", null, "UNIVERSAL", {
    priority: 95,
    classification: "SAFETY",
    news: "RELEASE",
    parameters: { void: "about 60 seconds after the release" },
    guidance:
      "The first minute after a release is not an entry window. Spread, slippage and two-way wicks dominate; wait for a later close.",
  }),
  rule("NEWS.NO_STOP_ENTRY", "news", null, "UNIVERSAL", {
    priority: 90,
    classification: "SAFETY",
    news: "RELEASE",
    guidance:
      "Do not use stop orders to catch the release spike. They fill at the worst slippage. A later limit at a calculated level is the calmer path.",
  }),
  rule("NEWS.M5_CLOSE", "news", "news-protocol", "UNIVERSAL", {
    news: "POST",
    parameters: {
      confirmation: "first M5 body near 70% of its range, outside the pre-release range",
    },
    guidance:
      "After the freeze, the first five-minute close outside the pre-release range is the reference for direction. A one-minute close is noise.",
  }),
  rule("NEWS.STABILITY_WINDOW", "news", "news-protocol", "UNIVERSAL", {
    news: "POST",
    parameters: { window: "about 15 to 30 minutes after the release" },
    guidance:
      "The calmer entries are usually in the quarter hour after the release, on a retest of the break, not in the spike itself.",
  }),
  rule("NEWS.ABSORPTION", "news", "news-protocol", "UNIVERSAL", {
    news: "POST",
    parameters: { absorption: "return to the release price within a few minutes" },
    guidance:
      "If price gives back the whole spike quickly, that is evidence the print was absorbed. Continuing to chase the first spike is then the weaker idea.",
  }),
  rule("NEWS.UNSCHEDULED", "news", "news-protocol", "UNIVERSAL", {
    news: "UNSCHEDULED",
    priority: 50,
    guidance:
      "A sudden range expansion with a spread jump and no calendar event is a candidate breaking-news candle. Confirm from a headline before treating it as a regime change.",
  }),
  rule("NEWS.CANDLE_ATR", "news-candle", "news-candle", "UNIVERSAL", {
    news: "ANY",
    parameters: { range: "about 3× the 14-period ATR", zScore: "above about 4 versus the session" },
    guidance:
      "A candle whose range is several times ATR, or an extreme outlier versus the session, is a news-candle candidate. Say candidate, not certain.",
  }),
  rule("NEWS.CANDLE_SPREAD", "news-candle", "news-candle", "UNIVERSAL", {
    news: "ANY",
    parameters: { spread: "about 3× the typical spread, especially inside a liquid session" },
    guidance:
      "A spread that blows out inside an otherwise liquid session is evidence of a liquidity vacuum. Combined with range expansion it supports the news-candle reading.",
  }),
  rule("NEWS.CANDLE_TICKS", "news-candle", "news-candle", "UNIVERSAL", {
    news: "ANY",
    parameters: { ticks: "several standard deviations above the recent tick-rate" },
    guidance:
      "A tick-rate far above its recent baseline supports a news-candle reading. A huge candle on thin ticks is more consistent with a vacuum than with participation.",
  }),
  rule("NEWS.GOLD_SHOCK", "news", "xauusd-behavior", "XAUUSD", {
    currencies: ["XAU"],
    news: "UNSCHEDULED",
    guidance:
      "For gold specifically, a confirmed geopolitical shock is a reason to drop ordinary bearish technicals as the primary prior. It is not a reason to sell other markets the same way, and it is not permission to buy.",
  }),
];

function rule(
  id: string,
  category: string,
  group: string | null,
  scope: PlaybookScope,
  extra: Partial<PlaybookRule> & { guidance: string },
): PlaybookRule {
  return {
    id,
    category,
    group,
    scope,
    currencies: [],
    timeframes: [],
    sessions: [],
    news: "ANY",
    intents: ["ANALYZE", "RECOMMEND", "MONITOR", "MANAGE"],
    priority: 20,
    classification: "HEURISTIC",
    parameters: {},
    ...extra,
  };
}

export const TRADING_PLAYBOOK: PlaybookRule[] = [
  ...UNIVERSAL,
  ...NORMALIZED,
  ...FX,
  ...GOLD,
  ...NEWS,
];

export const PLAYBOOK_GROUPS = [
  ["entry-timing", "Entry timing"],
  ["retest", "Retests"],
  ["trendline", "Trendlines"],
  ["candle", "Candles"],
  ["targets", "Targets"],
  ["execution", "Execution discipline"],
  ["news-protocol", "News protocol"],
  ["news-candle", "News-candle detection"],
  ["xauusd-behavior", "Gold-specific behavior"],
] as const;

export interface PlaybookQuery {
  symbol?: string;
  /** Verified broker specification. Used for classification, never as an order symbol. */
  baseCurrency?: string | null;
  quoteCurrency?: string | null;
  timeframe?: string;
  intent?: PlaybookIntent;
  /** PRE, RELEASE, POST, UNSCHEDULED, or NONE when no event is in view. */
  news?: PlaybookNews;
  disabledGroups?: string[];
  limit?: number;
}

export interface PlaybookSelection {
  version: string;
  exposure: InstrumentExposure | null;
  macro: ReturnType<typeof macroExposure>;
  rules: PlaybookRule[];
}

/** Relevant slice only. Gold-only rules stay out unless the instrument is gold. */
export function selectPlaybook(query: PlaybookQuery): PlaybookSelection {
  const exposure = query.symbol
    ? instrumentExposure(query.symbol, {
        baseCurrency: query.baseCurrency,
        quoteCurrency: query.quoteCurrency,
      })
    : null;
  const disabled = new Set(query.disabledGroups ?? []);
  const news = query.news ?? "NONE";
  const matched = TRADING_PLAYBOOK.filter((item) => {
    if (item.classification === "HEURISTIC" && item.group && disabled.has(item.group)) return false;
    if (query.intent && !item.intents.includes(query.intent)) return false;
    if (item.timeframes.length && query.timeframe && !item.timeframes.includes(query.timeframe))
      return false;
    if (item.news !== "ANY" && item.news !== news) return false;
    if (item.scope === "UNIVERSAL" || item.scope === "NORMALIZED")
      return exposure !== null || !query.symbol;
    if (!exposure) return false;
    if (item.scope === "XAUUSD") return exposure.themes.includes("gold");
    if (item.scope === "FX") {
      if (exposure.instrumentClass === "FX") return true;
      return item.currencies.some((currency) => exposure.currencies.includes(currency));
    }
    return false;
  });
  const relevance = (item: PlaybookRule) =>
    item.priority + (item.scope === "UNIVERSAL" || item.scope === "NORMALIZED" ? 0 : 25);
  matched.sort(
    (a, b) =>
      relevance(b) - relevance(a) ||
      Number(b.classification === "SAFETY") - Number(a.classification === "SAFETY") ||
      a.id.localeCompare(b.id),
  );
  return {
    version: TRADING_PLAYBOOK_VERSION,
    exposure,
    macro: query.symbol ? macroExposure(query.symbol) : [],
    rules: matched.slice(0, Math.min(query.limit ?? 24, 40)),
  };
}

export type PlaybookOutcome = "DENY" | "WAIT" | "CANDIDATE";

/**
 * Precedence is fixed: safety, broker/mandate/risk, news protection, then heuristics.
 * A heuristic never creates a mandate and never overturns a risk denial.
 */
export function resolvePlaybookAction(input: {
  riskDecision: "ALLOW" | "DENY";
  hasMandate: boolean;
  emergencyStop: boolean;
  newsFreeze: boolean;
  heuristic: "ENTER" | "WAIT" | "NONE";
}): { outcome: PlaybookOutcome; precedence: string } {
  if (input.emergencyStop) return { outcome: "DENY", precedence: "EMERGENCY" };
  if (input.riskDecision === "DENY") return { outcome: "DENY", precedence: "RISK_ENGINE" };
  if (!input.hasMandate) return { outcome: "WAIT", precedence: "NO_MANDATE" };
  if (input.newsFreeze) return { outcome: "WAIT", precedence: "NEWS_PROTECTION" };
  if (input.heuristic === "WAIT") return { outcome: "WAIT", precedence: "PLAYBOOK_WAIT" };
  if (input.heuristic === "ENTER") return { outcome: "CANDIDATE", precedence: "HEURISTIC" };
  return { outcome: "WAIT", precedence: "NO_HEURISTIC" };
}

const SCALE = 10n ** 12n;

function units(value: string): bigint | null {
  try {
    return financialUnits(value);
  } catch {
    return null;
  }
}

/** Mean of the last `period` true ranges. Callers supply high-low (and gap) ranges. */
export function averageRange(ranges: string[], period = 14): string | null {
  const sample = ranges.slice(-period).map(units);
  if (sample.length < Math.min(period, 2) || sample.some((value) => value === null || value <= 0n))
    return null;
  const total = sample.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  return financialDecimal(total / BigInt(sample.length));
}

/** How many ATRs the latest range is. Above ~3 is a news-candle candidate, not a certainty. */
export function rangeMultiple(range: string, atr: string): string | null {
  const span = units(range);
  const typical = units(atr);
  if (span === null || typical === null || typical <= 0n) return null;
  return financialDecimal((span * SCALE) / typical);
}

export function spreadMultiple(spread: string, typical: string): string | null {
  return rangeMultiple(spread, typical);
}

/** Signed z-score of the latest sample against the earlier ones. */
export function zScore(samples: string[]): string | null {
  const values = samples.map(units);
  if (values.length < 5 || values.some((value) => value === null)) return null;
  const latest = values.at(-1)!;
  const base = values.slice(0, -1) as bigint[];
  const mean = base.reduce((sum, value) => sum + value, 0n) / BigInt(base.length);
  const variance =
    base.reduce((sum, value) => sum + (value - mean) * (value - mean), 0n) / BigInt(base.length);
  if (variance <= 0n) return null;
  let deviation = 0n;
  let step = variance;
  for (let bit = 0; bit < 80 && step > 0n; bit++) {
    const next = deviation + step;
    if (next * next <= variance) deviation = next;
    step /= 2n;
  }
  if (deviation === 0n) return null;
  const score = ((latest - mean) * SCALE) / deviation;
  return financialDecimal(score);
}

export function bodyRangeRatio(candle: {
  open: string;
  high: string;
  low: string;
  close: string;
}): string | null {
  const [open, high, low, close] = [candle.open, candle.high, candle.low, candle.close].map(units);
  if ([open, high, low, close].some((value) => value === null)) return null;
  const span = high! - low!;
  if (span <= 0n) return null;
  const body = close! > open! ? close! - open! : open! - close!;
  return financialDecimal((body * SCALE) / span);
}

export function quoteAgeMs(sourceTime: string, now: Date): number | null {
  const at = Date.parse(sourceTime);
  if (!Number.isFinite(at)) return null;
  return now.getTime() - at;
}

export function consecutiveDirection(closes: Array<{ open: string; close: string }>): {
  direction: "UP" | "DOWN" | "MIXED";
  count: number;
} {
  let direction: "UP" | "DOWN" | null = null;
  let count = 0;
  for (const candle of [...closes].reverse()) {
    const open = units(candle.open);
    const close = units(candle.close);
    if (open === null || close === null || close === open) break;
    const next = close > open ? "UP" : "DOWN";
    if (direction && next !== direction) break;
    direction = next;
    count++;
  }
  return { direction: direction ?? "MIXED", count };
}

const SESSIONS = [
  ["Asia/Tokyo", "TOKYO"],
  ["Europe/London", "LONDON"],
  ["America/New_York", "NEW_YORK"],
] as const;

function hourIn(time: Date, zone: string): number | null {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(time)
    .find((part) => part.type === "hour")?.value;
  const parsed = Number(hour);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Venue sessions from IANA zones, so daylight saving stays in the clock rather than in a fixed offset. */
export function tradingSessions(time: Date): string[] {
  return SESSIONS.flatMap(([zone, name]) => {
    const hour = hourIn(time, zone);
    return hour !== null && hour >= 8 && hour < 17 ? [name] : [];
  });
}

export function timeToEventMs(eventTime: string, now: Date): number | null {
  const at = Date.parse(eventTime);
  if (!Number.isFinite(at)) return null;
  return at - now.getTime();
}

export interface NewsCandleEvidence {
  candidate: boolean;
  reasons: string[];
}

/** Evidence only. Three independent signs make a candidate; none of them makes it certain. */
export function newsCandleEvidence(input: {
  range: string;
  atr: string;
  spread: string;
  typicalSpread: string;
  ranges?: string[];
  eventTime?: string | null;
  candleTime: string;
}): NewsCandleEvidence {
  const reasons: string[] = [];
  const multiple = rangeMultiple(input.range, input.atr);
  if (multiple && financialUnits(multiple) >= financialUnits("3")) reasons.push("RANGE_VS_ATR");
  const spread = spreadMultiple(input.spread, input.typicalSpread);
  if (spread && financialUnits(spread) >= financialUnits("3")) reasons.push("SPREAD_MULTIPLE");
  if (input.ranges) {
    const score = zScore([...input.ranges, input.range]);
    if (score && financialUnits(score) >= financialUnits("4")) reasons.push("RANGE_ZSCORE");
  }
  if (input.eventTime) {
    const delta = Math.abs(Date.parse(input.candleTime) - Date.parse(input.eventTime));
    if (Number.isFinite(delta) && delta <= 60_000) reasons.push("CALENDAR_ALIGNMENT");
  }
  return { candidate: reasons.length >= 2 || reasons.includes("CALENDAR_ALIGNMENT"), reasons };
}
