/** Hard product boundary before user rules, model review or tool approval replay. */
const REVIEWED_SUPPORT_TOOLS = new Set([
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

/** Opaque mutation-capable tools retain their normal capabilities, behind mandatory independent review. */
export function tradingSupportReviewRequired(toolName: string, viaConnector: boolean): boolean {
  return viaConnector || REVIEWED_SUPPORT_TOOLS.has(toolName);
}
export type FinancialToolDecision =
  | { decision: "ALLOW" }
  | {
      decision: "DENY";
      code: "STRUCTURED_EXECUTION_REQUIRED" | "UNVERIFIED_CONNECTOR" | "ACCOUNT_SCOPE_REQUIRED";
      reason: string;
    };

/** Fresh trusted reads must not replay a stored generic result after approval/restart. */
export function financialBuiltinRead(toolName: string, operation: unknown): boolean {
  if (toolName === "broker_read") return true;
  return (
    ["trade_prepare", "trading_mission"].includes(toolName) &&
    ["get", "list"].includes(typeof operation === "string" ? operation : "")
  );
}

/** Account visibility is separate from trading expertise. Mandate/risk admission belongs to the domain executor. */
export function financialToolPolicy(input: {
  tradingProduct: boolean;
  toolName: string;
  viaConnector: boolean;
  operation?: string;
  accountReadsAllowed?: boolean;
}): FinancialToolDecision {
  if (!input.tradingProduct) return { decision: "ALLOW" };
  if (
    input.toolName === "broker_read" &&
    ["account", "positions", "orders", "preflight"].includes(input.operation ?? "") &&
    input.accountReadsAllowed !== true
  )
    return {
      decision: "DENY",
      code: "ACCOUNT_SCOPE_REQUIRED",
      reason:
        "Account reads require owner-granted access or this exact Agent's active mandate for the requested account.",
    };
  return { decision: "ALLOW" };
}
