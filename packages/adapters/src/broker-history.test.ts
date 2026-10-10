import { financialUnits } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { closedPositionPnl } from "./broker-history.js";
import { normalizePositionHistory } from "./metaapi-normalize.js";

const deal = {
  id: "entry",
  positionId: "position",
  time: new Date("2026-10-09T10:00:00Z"),
  entryType: "DEAL_ENTRY_IN",
  volume: 0.2,
  profit: 0,
  commission: -1,
  swap: 0,
  token: "fixture-secret-sentinel",
};
const exit = { ...deal, id: "exit", entryType: "DEAL_ENTRY_OUT", profit: 5, swap: -1 };
describe("trusted realized provider history", () => {
  it("counts entry and exit costs with exact decimals and strips untrusted diagnostics", () => {
    const history = normalizePositionHistory(
      { synchronizing: false, deals: [deal, exit], token: "fixture-secret-sentinel" },
      "account",
      "position",
    );
    expect(closedPositionPnl(history)).toBe(financialUnits("2"));
    expect(JSON.stringify(history)).not.toContain("fixture-secret-sentinel");
  });
  it.each([
    { synchronizing: true, deals: [deal, exit] },
    { synchronizing: false, deals: [deal] },
    { synchronizing: false, deals: [deal, { ...exit, volume: 0.1 }] },
    { synchronizing: false, deals: [] },
  ])("does not fabricate realized PnL from incomplete history %#", (input) => {
    expect(closedPositionPnl(normalizePositionHistory(input, "account", "position"))).toBeNull();
  });
  it.each([
    { ...exit, positionId: "different-position" },
    { ...exit, commission: undefined },
    { ...exit, swap: undefined },
    { ...exit, entryType: "DEAL_ENTRY_INOUT" },
    { ...exit, volume: -1 },
  ])("rejects unknown attribution, cost, precision or netting reversal %#", (invalid) => {
    expect(() =>
      normalizePositionHistory(
        { synchronizing: false, deals: [deal, invalid] },
        "account",
        "position",
      ),
    ).toThrow();
  });
});
