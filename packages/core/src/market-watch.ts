import type { BrokerQuote, MarketCondition } from "@rakazo/contracts";
import {
  BrokerQuoteSchema,
  MarketConditionSchema,
  PositiveTradingDecimalSchema,
} from "@rakazo/contracts";

function units(value: string) {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
}
/** Only boundary changes matter to durable crossing state; repeated quotes remain ephemeral. */
export function marketConditionSide(value: string, threshold: string): "ABOVE" | "BELOW" | "EQUAL" {
  const current = units(PositiveTradingDecimalSchema.parse(value));
  const target = units(PositiveTradingDecimalSchema.parse(threshold));
  return current > target ? "ABOVE" : current < target ? "BELOW" : "EQUAL";
}
/** Observation only: no LLM, clock, I/O or trading authority. Caller supplies trusted server time. */
export function observeMarketCondition(input: {
  condition: MarketCondition;
  quote: BrokerQuote;
  now: Date;
  previousValue: string | null;
  previousSourceTime: string | null;
}) {
  const condition = MarketConditionSchema.parse(input.condition);
  const quote = BrokerQuoteSchema.parse(input.quote);
  const age = input.now.getTime() - Date.parse(quote.sourceTime);
  const receivedAge = input.now.getTime() - Date.parse(quote.receivedAt);
  if (
    age < -2000 ||
    age > 15000 ||
    receivedAge < -2000 ||
    receivedAge > 15000 ||
    (input.previousSourceTime &&
      Date.parse(quote.sourceTime) <= Date.parse(input.previousSourceTime))
  )
    return { observed: false, fire: false, value: input.previousValue };
  const value = condition.field === "BID" ? quote.bid : quote.ask;
  const current = units(value);
  const threshold = units(condition.price);
  const previous = input.previousValue === null ? null : units(input.previousValue);
  const fire =
    condition.comparison === "AT_OR_ABOVE"
      ? current >= threshold
      : condition.comparison === "AT_OR_BELOW"
        ? current <= threshold
        : condition.comparison === "CROSS_ABOVE"
          ? previous !== null && previous <= threshold && current > threshold
          : previous !== null && previous >= threshold && current < threshold;
  return { observed: true, fire, value };
}
