/** Hard product boundary before user rules, model review or tool approval replay. */
const HUMAN_CONTROL_ONLY = new Set([
  "read_file",
  "list_files",
  "write_file",
  "attach_file",
  "computer_act",
  "browser_act",
  "browser_navigate",
  "shell",
  "launch_app",
  "open_path",
  "secret_request",
  "request_secret",
  "add_mcp_server",
  "cloud_agent_launch",
  "cloud_agent_reply",
]);
export type FinancialToolDecision =
  | { decision: "ALLOW" }
  | {
      decision: "DENY";
      code: "STRUCTURED_EXECUTION_REQUIRED" | "UNVERIFIED_CONNECTOR";
      reason: string;
    };

/**
 * Browser sessions and arbitrary process/API/MCP capabilities cannot prove bounded financial
 * authority. In the trading product, those actions remain available to human takeover only.
 * There is deliberately no domain/name heuristic and no mandate exception for an opaque tool.
 * Trusted structured broker execution will have its own mandatory authorization/risk boundary.
 */
export function financialToolPolicy(input: {
  tradingProduct: boolean;
  toolName: string;
  viaConnector: boolean;
}): FinancialToolDecision {
  if (!input.tradingProduct) return { decision: "ALLOW" };
  if (input.viaConnector)
    return {
      decision: "DENY",
      code: "UNVERIFIED_CONNECTOR",
      reason:
        "This connector cannot prove financial authority. Use trusted broker tools; use human takeover for other actions.",
    };
  if (HUMAN_CONTROL_ONLY.has(input.toolName))
    return {
      decision: "DENY",
      code: "STRUCTURED_EXECUTION_REQUIRED",
      reason:
        "Automated Computer, process and credential actions cannot bypass trading authorization. Request human takeover or use trusted structured tools.",
    };
  return { decision: "ALLOW" };
}
