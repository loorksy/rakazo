import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock, buildFinancialApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("shows exact material financial terms and mode without offering blanket approval", () => {
    const action = {
      version: 1,
      mode: "SIMULATION",
      provider: "metaapi",
      accountId: "fixture-account",
      instrumentId: "gold",
      brokerSymbol: "GOLD.a",
      operation: "OPEN",
      side: "BUY",
      orderType: "LIMIT",
      volume: "0.01",
      price: "2000",
      stopLimitPrice: null,
      expiresAt: "2026-10-10T10:00:00Z",
      fillingMode: null,
      stopLoss: "1995",
      takeProfit: "2010",
    };
    const block = buildFinancialApprovalAskBlock("effect", action, ["sentinel"], "Review sentinel");
    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect",
      actions: [
        { id: "allow", label: "Approve once" },
        { id: "deny", label: "Deny" },
      ],
    });
    if (block.kind !== "ask") throw new Error("Expected financial ask");
    expect(block.text).toContain("simulation");
    expect(block.detail).toContain('"volume": "0.01"');
    expect(block.detail).toContain('"stopLoss": "1995"');
    expect(block.detail).toContain('"expiresAt": "2026-10-10T10:00:00Z"');
    expect(JSON.stringify(block)).not.toContain("sentinel");
  });
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
});
