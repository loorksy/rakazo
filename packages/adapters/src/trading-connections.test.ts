import { describe, expect, it } from "vitest";
import { accountCatalogSummary } from "./trading-connections.js";

describe("agent account catalog", () => {
  it("separates a missing connection from a missing account-read grant", () => {
    expect(accountCatalogSummary([])).toBe("No broker account is connected.");
    expect(accountCatalogSummary([{ accountRead: false }])).toBe(
      "A broker account is connected. This Agent does not have account-read permission.",
    );
    expect(accountCatalogSummary([{ accountRead: false }, { accountRead: false }])).not.toBe(
      "No broker account is connected.",
    );
    expect(accountCatalogSummary([{ accountRead: true }, { accountRead: false }])).toBe(
      "This Agent can read the permitted account state.",
    );
  });
});
