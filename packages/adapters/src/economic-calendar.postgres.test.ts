import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readScheduledEvents,
  scheduledNewsPhase,
  storeCalendarEvents,
} from "./economic-calendar.js";

const url = process.env.CALENDAR_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;

suite("economic calendar cache", () => {
  let db: ReturnType<typeof createDb>;
  const now = new Date("2026-10-09T12:20:00.000Z");
  beforeAll(async () => {
    if (!url?.endsWith("calendar_test"))
      throw new Error("Dedicated calendar_test database required");
    db = createDb(url);
    process.env.ECONOMIC_CALENDAR_PROVIDER = "fmp";
    process.env.ECONOMIC_CALENDAR_API_KEY = "fixture-calendar-key";
    await db.prisma.economicCalendarEvent.deleteMany();
  });
  afterAll(async () => {
    delete process.env.ECONOMIC_CALENDAR_PROVIDER;
    delete process.env.ECONOMIC_CALENDAR_API_KEY;
    if (!db) return;
    await db.prisma.economicCalendarEvent.deleteMany();
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it("stores one copy and maps the phase to the instrument currencies", async () => {
    const event = {
      provider: "fmp" as const,
      eventKey: "cpi",
      title: "CPI",
      currency: "USD",
      country: "US",
      impact: "HIGH" as const,
      occursAt: "2026-10-09T12:30:00.000Z",
      actual: null,
      forecast: "3.2",
      previous: "3.1",
      revision: null,
    };
    await storeCalendarEvents(db.prisma, "fmp", [event, event], now);
    await storeCalendarEvents(db.prisma, "fmp", [event], now);
    expect(await db.prisma.economicCalendarEvent.count()).toBe(1);
    const eur = await readScheduledEvents(db.prisma, ["EUR", "USD"], now);
    expect(eur).toHaveLength(1);
    expect(JSON.stringify(eur)).not.toContain("fixture-calendar-key");
    expect(await scheduledNewsPhase(db.prisma, ["EUR", "USD"], now)).toBe("PRE");
    expect(await scheduledNewsPhase(db.prisma, ["GBP", "JPY"], now)).toBe("NONE");
    expect(await scheduledNewsPhase(db.prisma, ["XAU", "USD"], now)).toBe("PRE");
    delete process.env.ECONOMIC_CALENDAR_PROVIDER;
    expect(await readScheduledEvents(db.prisma, ["USD"], now)).toEqual([]);
    process.env.ECONOMIC_CALENDAR_PROVIDER = "fmp";
  });
});
