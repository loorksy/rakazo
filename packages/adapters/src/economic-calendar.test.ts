import { describe, expect, it } from "vitest";
import { normalizeCalendar, zonedWallTimeToUtc } from "./economic-calendar.js";

const fmp = [
  {
    date: "2026-07-15 08:30:00",
    country: "US",
    event: "CPI",
    currency: "USD",
    previous: 3.1,
    estimate: 3.2,
    actual: null,
    impact: "High",
    apiKey: "fixture-secret-sentinel",
  },
  {
    date: "2026-07-15 08:30:00",
    country: "JP",
    event: "BoJ rate",
    currency: "JPY",
    previous: 0.5,
    estimate: 0.5,
    impact: "Medium",
  },
];
const finnhub = {
  economicCalendar: [
    {
      actual: null,
      country: "GB",
      estimate: 2.1,
      event: "UK CPI",
      impact: "high",
      prev: 2,
      time: "2026-01-15 07:00:00",
      token: "fixture-secret-sentinel",
    },
  ],
};

describe("economic calendar normalization", () => {
  it("converts provider wall times to UTC, including New York daylight time", () => {
    expect(zonedWallTimeToUtc("2026-07-15 08:30:00", "America/New_York")).toBe(
      "2026-07-15T12:30:00.000Z",
    );
    expect(zonedWallTimeToUtc("2026-01-15 08:30:00", "America/New_York")).toBe(
      "2026-01-15T13:30:00.000Z",
    );
    expect(zonedWallTimeToUtc("2026-01-15 07:00:00", "UTC")).toBe("2026-01-15T07:00:00.000Z");
  });
  it("normalizes both providers and drops credentials", () => {
    const first = normalizeCalendar("fmp", fmp);
    const second = normalizeCalendar("finnhub", finnhub);
    expect(first.map((event) => event.currency)).toEqual(["USD", "JPY"]);
    expect(first[0]).toMatchObject({
      impact: "HIGH",
      title: "CPI",
      occursAt: "2026-07-15T12:30:00.000Z",
      forecast: "3.2",
      previous: "3.1",
      actual: null,
    });
    expect(second[0]).toMatchObject({
      currency: "GBP",
      impact: "HIGH",
      occursAt: "2026-01-15T07:00:00.000Z",
      country: "GB",
    });
    expect(JSON.stringify([...first, ...second])).not.toContain("fixture-secret-sentinel");
  });
  it("returns no events from an empty or malformed feed", () => {
    expect(normalizeCalendar("fmp", [])).toEqual([]);
    expect(normalizeCalendar("finnhub", { economicCalendar: [] })).toEqual([]);
    expect(normalizeCalendar("fmp", { unexpected: true })).toEqual([]);
  });
});
