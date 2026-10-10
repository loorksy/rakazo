import { describe, expect, it } from "vitest";
import {
  financialBuiltinRead,
  financialToolPolicy,
  tradingSupportReviewRequired,
} from "./financial-tool-policy.js";

describe("hard financial tool boundary", () => {
  it("refreshes structured reads without classifying execution or internal writes as read-only", () => {
    expect(financialBuiltinRead("broker_read", "preflight")).toBe(true);
    expect(financialBuiltinRead("trade_prepare", "get")).toBe(true);
    expect(financialBuiltinRead("trading_mission", "list")).toBe(true);
    for (const [name, operation] of [
      ["trade_execute", "get"],
      ["trade_reconcile", "get"],
      ["trade_prepare", "preview"],
      ["trading_mission", "mandate_propose"],
      ["unknown_connector", "get"],
    ])
      expect(financialBuiltinRead(name ?? "", operation)).toBe(false);
  });
  it.each(["trading_mission", "trade_prepare", "trade_execute", "trade_reconcile"])(
    "%s reaches its exact per-Agent mandate handler",
    (toolName) => {
      expect(
        financialToolPolicy({
          tradingProduct: true,
          toolName,
          viaConnector: false,
          accountReadsAllowed: false,
        }).decision,
      ).toBe("ALLOW");
      expect(
        financialToolPolicy({
          tradingProduct: true,
          toolName,
          viaConnector: false,
          accountReadsAllowed: true,
        }).decision,
      ).toBe("ALLOW");
    },
  );
  it.each([
    "read_file",
    "list_files",
    "write_file",
    "attach_file",
    "shell",
    "computer_act",
    "browser_act",
    "browser_navigate",
    "launch_app",
    "open_path",
    "secret_request",
    "request_secret",
    "add_mcp_server",
  ])("restores %s under its normal policy", (toolName) => {
    expect(
      financialToolPolicy({
        tradingProduct: true,
        toolName,
        viaConnector: false,
        researchUrlAllowed: true,
      }).decision,
    ).toBe("ALLOW");
  });
  it.each([
    "GET_balance",
    "readOnly_buy",
    "mcp_execute_tool",
    "connector_execute_tool",
    "harmless_name",
  ])("independently reviews connector %s", (toolName) => {
    expect(tradingSupportReviewRequired(toolName, true)).toBe(true);
  });
  it.each([
    "broker_read",
    "chart_workspace",
    "chart_indicators",
    "chart_inspect",
    "market_watch",
    "computer_observe",
    "browser_snapshot",
    "request_takeover",
    "web_search",
    "web_fetch",
    "run_subagent",
  ])("retains safe structured/research %s", (toolName) => {
    expect(
      financialToolPolicy({
        tradingProduct: true,
        toolName,
        viaConnector: false,
        researchUrlAllowed: true,
      }).decision,
    ).toBe("ALLOW");
  });
  it.each(["account", "positions", "orders", "preflight"])(
    "does not delegate %s authority to research peers",
    (operation) => {
      expect(
        financialToolPolicy({
          tradingProduct: true,
          toolName: "broker_read",
          viaConnector: false,
          operation,
          accountReadsAllowed: false,
        }).decision,
      ).toBe("DENY");
      expect(
        financialToolPolicy({
          tradingProduct: true,
          toolName: "broker_read",
          viaConnector: false,
          operation,
          accountReadsAllowed: true,
        }).decision,
      ).toBe("ALLOW");
    },
  );
  it("preserves upstream product behavior outside the enforced trading deployment", () => {
    expect(
      financialToolPolicy({ tradingProduct: false, toolName: "shell", viaConnector: false })
        .decision,
    ).toBe("ALLOW");
  });
  it.each(["buy", "readOnly_order", "http_get", "execute_tool"])(
    "blocks opaque MCP %s regardless of name or model approval",
    (toolName) => {
      expect(
        financialToolPolicy({ tradingProduct: true, viaConnector: true, toolName }).decision,
      ).toBe("DENY");
    },
  );
  it("permits trusted nonfinancial connector contracts and denies unknown web destinations", () => {
    expect(
      financialToolPolicy({
        tradingProduct: true,
        viaConnector: true,
        toolName: "market_research",
        connectorFinancialClass: "NON_FINANCIAL",
      }).decision,
    ).toBe("ALLOW");
    expect(
      financialToolPolicy({
        tradingProduct: true,
        viaConnector: false,
        toolName: "web_fetch",
        researchUrlAllowed: false,
      }).decision,
    ).toBe("DENY");
  });
});
