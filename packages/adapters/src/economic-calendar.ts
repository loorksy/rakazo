import { createHash } from "node:crypto";
import { newsPhaseForCurrencies, type PlaybookNews } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

type CalendarDb = PrismaClient | Prisma.TransactionClient;

import type { Logger } from "@rakazo/logging";

const PROVIDERS = ["fmp", "finnhub"] as const;
type Provider = (typeof PROVIDERS)[number];
const WINDOW_BACK_MS = 6 * 60 * 60 * 1000;
const WINDOW_FORWARD_MS = 48 * 60 * 60 * 1000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 500;
const HOSTS: Record<Provider, string> = {
  fmp: "financialmodelingprep.com",
  finnhub: "finnhub.io",
};

export interface CalendarEvent {
  provider: Provider;
  eventKey: string;
  title: string;
  currency: string;
  country: string | null;
  impact: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  occursAt: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  revision: string | null;
}

const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD",
  USA: "USD",
  EU: "EUR",
  EZ: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  UK: "GBP",
  GB: "GBP",
  JP: "JPY",
  AU: "AUD",
  NZ: "NZD",
  CA: "CAD",
  CH: "CHF",
  CN: "CNH",
};

export function calendarProvider(env: NodeJS.ProcessEnv = process.env): Provider | null {
  const value = env.ECONOMIC_CALENDAR_PROVIDER?.trim().toLowerCase();
  return PROVIDERS.find((provider) => provider === value) ?? null;
}

function impact(value: unknown): CalendarEvent["impact"] {
  const text = String(value ?? "").toUpperCase();
  if (text.startsWith("HIGH") || text === "3") return "HIGH";
  if (text.startsWith("MED") || text === "2") return "MEDIUM";
  if (text.startsWith("LOW") || text === "1") return "LOW";
  return "UNKNOWN";
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  return raw && raw.length <= 64 && !/token|secret|key/i.test(raw) ? raw : null;
}

function currencyOf(value: unknown, country: unknown): string | null {
  const direct = String(value ?? "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]{3}$/.test(direct)) return direct;
  return (
    COUNTRY_CURRENCY[
      String(country ?? "")
        .trim()
        .toUpperCase()
    ] ?? null
  );
}

/** A zoned wall time with no offset. The provider documents which zone it is. */
export function zonedWallTimeToUtc(
  value: string,
  timeZone: "UTC" | "America/New_York",
): string | null {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  if (timeZone === "UTC")
    return new Date(
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}Z`,
    ).toISOString();
  const wanted = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  );
  let guess = wanted;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(guess));
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const shown = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
    );
    const delta = shown - wanted;
    if (delta === 0) return new Date(guess).toISOString();
    guess -= delta;
  }
  return null;
}

function eventKey(currency: string, occursAt: string, title: string) {
  return createHash("sha256")
    .update(`${currency}|${occursAt}|${title.toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export function normalizeCalendar(provider: Provider, payload: unknown): CalendarEvent[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { economicCalendar?: unknown }).economicCalendar)
      ? (payload as { economicCalendar: unknown[] }).economicCalendar
      : [];
  const events: CalendarEvent[] = [];
  for (const row of rows.slice(0, MAX_EVENTS)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const title = String(record.event ?? record.title ?? "")
      .trim()
      .slice(0, 180);
    const currency = currencyOf(record.currency, record.country);
    const occursAt = zonedWallTimeToUtc(
      String(record.date ?? record.time ?? ""),
      provider === "fmp" ? "America/New_York" : "UTC",
    );
    if (!title || !currency || !occursAt) continue;
    events.push({
      provider,
      eventKey: eventKey(currency, occursAt, title),
      title,
      currency,
      country: text(record.country),
      impact: impact(record.impact),
      occursAt,
      actual: text(record.actual),
      forecast: text(record.estimate ?? record.forecast),
      previous: text(record.previous ?? record.prev),
      revision: text(record.revision ?? record.revised),
    });
  }
  return events;
}

async function fetchProvider(provider: Provider, key: string, now: Date, fetchImpl: typeof fetch) {
  const from = new Date(now.getTime() - WINDOW_BACK_MS).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + WINDOW_FORWARD_MS).toISOString().slice(0, 10);
  const url =
    provider === "fmp"
      ? new URL("https://financialmodelingprep.com/api/v3/economic_calendar")
      : new URL("https://finnhub.io/api/v1/calendar/economic");
  if (url.hostname !== HOSTS[provider]) throw new Error("Calendar host rejected");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set(provider === "fmp" ? "apikey" : "token", key);
  const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (response.status >= 300 && response.status < 400)
    throw new Error("Calendar redirect rejected");
  if (!response.ok) throw new Error(`Calendar HTTP ${response.status}`);
  return normalizeCalendar(provider, await response.json());
}

export async function storeCalendarEvents(
  prisma: CalendarDb,
  provider: Provider,
  events: CalendarEvent[],
  now: Date,
) {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    const id = `${provider}:${event.eventKey}`;
    const data = { ...event, id, fetchedAt: now };
    await prisma.economicCalendarEvent.upsert({
      where: { provider_eventKey: { provider, eventKey: event.eventKey } },
      create: data,
      update: data,
    });
  }
  await prisma.economicCalendarEvent.deleteMany({
    where: { occursAt: { lt: new Date(now.getTime() - RETAIN_MS) } },
  });
}

export async function readScheduledEvents(prisma: CalendarDb, currencies: string[], now: Date) {
  if (!calendarProvider() || !process.env.ECONOMIC_CALENDAR_API_KEY?.trim() || !currencies.length)
    return [];
  const rows = await prisma.economicCalendarEvent.findMany({
    where: {
      currency: { in: currencies },
      occursAt: {
        gte: new Date(now.getTime() - WINDOW_BACK_MS),
        lte: new Date(now.getTime() + WINDOW_FORWARD_MS),
      },
    },
    orderBy: { occursAt: "asc" },
    take: 50,
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    currency: row.currency,
    country: row.country,
    impact: row.impact,
    occursAt: row.occursAt.toISOString(),
    actual: row.actual,
    forecast: row.forecast,
    previous: row.previous,
    revision: row.revision,
  }));
}

export async function scheduledNewsPhase(
  prisma: CalendarDb,
  currencies: string[],
  now: Date,
): Promise<PlaybookNews> {
  const events = await readScheduledEvents(prisma, currencies, now);
  return newsPhaseForCurrencies(
    events.flatMap((event) =>
      event.impact === "HIGH" || event.impact === "MEDIUM" || event.impact === "LOW"
        ? [{ occursAt: event.occursAt, impact: event.impact, currency: event.currency }]
        : [],
    ),
    currencies,
    now,
  );
}

/** Worker-owned poll. A missing provider or a failed fetch adds nothing. */
export class EconomicCalendarPoller {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  start() {
    const poll = () => {
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((error: unknown) => {
          this.logger.warn("economic calendar poll failed", {
            status: error instanceof Error ? error.message.slice(0, 80) : "unavailable",
          });
        })
        .finally(() => {
          this.running = false;
        });
    };
    this.timer = setInterval(poll, POLL_MS);
    this.timer.unref();
    poll();
  }
  async tick(now = new Date()) {
    const provider = calendarProvider(this.env);
    const key = this.env.ECONOMIC_CALENDAR_API_KEY?.trim();
    if (!provider || !key) return;
    let events: CalendarEvent[];
    try {
      events = await fetchProvider(provider, key, now, this.fetchImpl);
    } catch {
      throw new Error("Calendar fetch failed");
    }
    await storeCalendarEvents(this.prisma, provider, events, now);
    this.logger.info("economic calendar refreshed", { provider, events: events.length });
  }
  close() {
    clearInterval(this.timer);
  }
}
