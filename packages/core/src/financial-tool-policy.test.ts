import { describe, expect, it } from "vitest";
import { financialToolPolicy } from "./financial-tool-policy.js";

describe("hard financial tool boundary", () => {
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
    "cloud_agent_launch",
    "cloud_agent_reply",
  ])("denies opaque %s without attempting model review", (toolName) => {
    expect(
      financialToolPolicy({ tradingProduct: true, toolName, viaConnector: false }).decision,
    ).toBe("DENY");
  });
  it.each([
    "GET_balance",
    "readOnly_buy",
    "mcp_execute_tool",
    "connector_execute_tool",
    "harmless_name",
  ])("does not trust connector naming: %s", (toolName) => {
    expect(
      financialToolPolicy({ tradingProduct: true, toolName, viaConnector: true }).decision,
    ).toBe("DENY");
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
      financialToolPolicy({ tradingProduct: true, toolName, viaConnector: false }).decision,
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
});
