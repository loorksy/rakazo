import type {
  BrokerCandle,
  BrokerQuote,
  FinancialAction,
  FinancialRiskFacts,
  TradingCapabilities,
} from "@rakazo/contracts";

export interface BrokerAccountState {
  accountId: string;
  currency: string;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  environment: "DEMO" | "REAL";
  accountMode: "HEDGING" | "NETTING" | "UNKNOWN";
  platform: "mt4" | "mt5";
  tradingAllowed: boolean;
  observedAt: string;
}
export interface BrokerPosition {
  id: string;
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: string;
  entry: string;
  currentPrice: string;
  stopLoss: string | null;
  takeProfit: string | null;
  profit: string;
  swap: string;
  commission: string;
  clientId: string | null;
  observedAt: string;
}
export interface BrokerOrder {
  id: string;
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "STOP" | "STOP_LIMIT";
  volume: string;
  price: string;
  stopLimitPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  expiresAt: string | null;
  clientId: string | null;
  observedAt: string;
}
export interface BrokerSymbolSpecification {
  accountId: string;
  symbol: string;
  description: string;
  baseCurrency: string | null;
  quoteCurrency: string | null;
  tickSize: string;
  minVolume: string;
  maxVolume: string;
  volumeStep: string;
  digits: number;
  stopsLevel: number;
  tradeMode: string;
  orderTypes: Array<"MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT">;
  fillingModes: string[];
  tradingSessions: Record<string, Array<{ from: string; to: string }>> | null;
  verifiedAt: string;
}
export type BrokerEvent =
  | { type: "quote"; quote: BrokerQuote }
  | {
      type: "account_changed";
      accountId: string;
      kind: string;
      reference: string | null;
      receivedAt: string;
    }
  | { type: "connection_changed"; accountId: string; connected: boolean; receivedAt: string };

/** Only trusted host code creates sessions. Raw SDK credentials/objects never cross this port. */
export interface BrokerReadSession {
  readonly accountId: string;
  /** Trusted Worker-only execution boundary; never returned by a read tool. */
  readonly execution?: ExecutionProvider;
  account(): Promise<BrokerAccountState>;
  positions(): Promise<BrokerPosition[]>;
  orders(): Promise<BrokerOrder[]>;
  symbols(): Promise<string[]>;
  specification(symbol: string): Promise<BrokerSymbolSpecification>;
  quote(symbol: string, instrumentId: string): Promise<BrokerQuote>;
  candles(input: {
    symbol: string;
    instrumentId: string;
    timeframe: string;
    before?: string;
    limit: number;
  }): Promise<BrokerCandle[]>;
  /** Fresh read-only broker preflight; optional providers fail closed when unavailable. */
  preflight?(action: FinancialAction): Promise<FinancialRiskFacts>;
  capabilities(): Promise<TradingCapabilities>;
  subscribe(
    symbols: Array<{ symbol: string; instrumentId: string }>,
    listener: (event: BrokerEvent) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
export interface BrokerProvider {
  readonly id: string;
  /** resolveCredential belongs to trusted SecretStore integration, not an agent tool argument. */
  connect(input: {
    accountId: string;
    providerAccountId: string;
    region?: string;
    resolveCredential: () => Promise<string>;
    signal?: AbortSignal;
  }): Promise<BrokerReadSession>;
}

/** Host-only port. A durable dispatcher, never model tools, supplies this request. */
export interface ExecutionRequest {
  effectId: string;
  clientId: string;
  action: FinancialAction;
  startedAt: string;
}
export interface ExecutionResult {
  status: "SUCCEEDED" | "FAILED" | "UNCERTAIN";
  providerReference: string | null;
  code: string | null;
}
export interface ExecutionProvider {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  /** Read-only recovery. Absence from a snapshot is never proof of non-acceptance. */
  reconcile(request: ExecutionRequest): Promise<ExecutionResult>;
}
