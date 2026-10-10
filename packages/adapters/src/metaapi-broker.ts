/// <reference path="./metaapi-sdk.d.ts" />
import type { BrokerEvent, BrokerProvider, BrokerReadSession } from "@rakazo/adapter-kit";
import type { FinancialAction } from "@rakazo/contracts";
import {
  FinancialActionSchema,
  FinancialRiskFactsSchema,
  TradingCapabilitiesSchema,
} from "@rakazo/contracts";
import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk/esm-node";
import { z } from "zod";
import type { MetaApiExecutionPort } from "./metaapi-execution.js";
import { MetaApiExecutionAdapter } from "./metaapi-execution.js";
import {
  BrokerProviderError,
  brokerSdkNumber,
  METAAPI_TIMEFRAMES,
  normalizeAccount,
  normalizeBrokerDecimal,
  normalizeCandles,
  normalizeOrders,
  normalizePositionHistory,
  normalizePositions,
  normalizeQuote,
  normalizeSpecification,
  sanitizedBrokerError,
} from "./metaapi-normalize.js";

/** Native SDK stays inside the trusted Worker. Read tools receive normalized read results only. */
export interface MetaApiRpcPort extends MetaApiExecutionPort {
  connect(): Promise<unknown>;
  waitSynchronized(timeoutSeconds?: number): Promise<unknown>;
  getAccountInformation(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOrders(): Promise<unknown>;
  getSymbols(): Promise<unknown>;
  getSymbolSpecification(symbol: string): Promise<unknown>;
  getSymbolPrice(symbol: string, keepSubscription: boolean): Promise<unknown>;
  getDealsByPosition?(positionId: string): Promise<unknown>;
  calculateMargin?(order: {
    symbol: string;
    type: "ORDER_TYPE_BUY" | "ORDER_TYPE_SELL";
    volume: number;
    openPrice: number;
  }): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface MetaApiStreamPort {
  connect(): Promise<unknown>;
  waitSynchronized(options: { timeoutInSeconds: number }): Promise<unknown>;
  addSynchronizationListener(listener: SynchronizationListener): void;
  removeSynchronizationListener(listener: SynchronizationListener): void;
  subscribeToMarketData(
    symbol: string,
    subscriptions: Array<{ type: "quotes" }>,
    timeoutSeconds?: number,
  ): Promise<unknown>;
  unsubscribeFromMarketData(
    symbol: string,
    subscriptions: Array<{ type: "quotes" }>,
  ): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface MetaApiAccountPort {
  readonly region: string;
  readonly state: string;
  readonly connectionStatus: string;
  getRPCConnection(): MetaApiRpcPort;
  getStreamingConnection(): MetaApiStreamPort;
  getHistoricalCandles(
    symbol: string,
    timeframe: string,
    before?: Date,
    limit?: number,
  ): Promise<unknown>;
}
export interface MetaApiSdkPort {
  metatraderAccountApi: { getAccount(id: string): Promise<MetaApiAccountPort> };
  close(): void;
}
export type MetaApiSdkFactory = (token: string, region?: string) => MetaApiSdkPort;
function nativeSdk(token: string, region?: string): MetaApiSdkPort {
  // Disable the vendor's default console logger. Application diagnostics contain only normalized codes.
  MetaApi.enableLog4jsLogging();
  return new MetaApi(token, {
    application: "Rakazo",
    region,
    requestTimeout: 20,
    connectTimeout: 20,
    packetLogger: { enabled: false },
    enableLatencyMonitor: false,
    enableLatencyTracking: false,
  });
}

class BrokerListener extends SynchronizationListener {
  constructor(
    private readonly accountId: string,
    private readonly symbols: Map<string, string>,
    private readonly emit: (event: BrokerEvent) => void,
    private readonly now: () => Date,
  ) {
    super();
  }
  override async onConnected(): Promise<void> {
    this.emit({
      type: "connection_changed",
      accountId: this.accountId,
      connected: true,
      receivedAt: this.now().toISOString(),
    });
  }
  override async onDisconnected(): Promise<void> {
    this.emit({
      type: "connection_changed",
      accountId: this.accountId,
      connected: false,
      receivedAt: this.now().toISOString(),
    });
  }
  override async onSymbolPricesUpdated(_instance: string, prices: unknown[]): Promise<void> {
    for (const input of prices.slice(0, 4096)) {
      const identity = z.object({ symbol: z.string() }).safeParse(input);
      if (!identity.success) continue;
      const instrumentId = this.symbols.get(identity.data.symbol);
      if (!instrumentId) continue;
      try {
        this.emit({
          type: "quote",
          quote: normalizeQuote(
            input,
            this.accountId,
            identity.data.symbol,
            instrumentId,
            this.now().toISOString(),
          ),
        });
      } catch {
        /* Malformed stream packets cannot poison state or leak their contents. */
      }
    }
  }
  private changed(kind: string): void {
    this.emit({
      type: "account_changed",
      accountId: this.accountId,
      kind,
      reference: null,
      receivedAt: this.now().toISOString(),
    });
  }
  override async onAccountInformationUpdated(): Promise<void> {
    this.changed("account");
  }
  override async onPositionsUpdated(): Promise<void> {
    this.changed("positions");
  }
  override async onPositionUpdated(): Promise<void> {
    this.changed("positions");
  }
  override async onPositionRemoved(): Promise<void> {
    this.changed("positions");
  }
  override async onPendingOrdersUpdated(): Promise<void> {
    this.changed("orders");
  }
  override async onPendingOrderUpdated(): Promise<void> {
    this.changed("orders");
  }
  override async onPendingOrderCompleted(): Promise<void> {
    this.changed("orders");
  }
}

export class MetaApiBrokerProvider implements BrokerProvider {
  readonly id = "metaapi";
  constructor(
    private readonly factory: MetaApiSdkFactory = nativeSdk,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async connect(input: Parameters<BrokerProvider["connect"]>[0]): Promise<BrokerReadSession> {
    if (
      !z.string().min(1).max(128).safeParse(input.providerAccountId).success ||
      (input.region !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(input.region))
    )
      throw new BrokerProviderError("INVALID_REQUEST");
    let sdk: MetaApiSdkPort | undefined;
    let rpc: MetaApiRpcPort | undefined;
    let opened: MetaApiReadSession | undefined;
    const abort = () => {
      if (opened) void opened.close();
      else {
        try {
          sdk?.close();
        } catch {
          /* Never leak raw SDK diagnostics. */
        }
      }
    };
    if (input.signal?.aborted) throw new BrokerProviderError("DISCONNECTED");
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const credential = await input.resolveCredential();
      if (input.signal?.aborted) throw new BrokerProviderError("DISCONNECTED");
      if (!credential || credential.length > 16384)
        throw new BrokerProviderError("INVALID_REQUEST");
      sdk = this.factory(credential, input.region);
      const account = await sdk.metatraderAccountApi.getAccount(input.providerAccountId);
      if (input.region && account.region !== input.region)
        throw new BrokerProviderError("INVALID_REQUEST");
      if (account.state !== "DEPLOYED" || account.connectionStatus !== "CONNECTED")
        throw new BrokerProviderError("DISCONNECTED");
      rpc = account.getRPCConnection();
      await rpc.connect();
      await rpc.waitSynchronized(20);
      if (input.signal?.aborted) throw new BrokerProviderError("DISCONNECTED");
      const session = new MetaApiReadSession(
        input.accountId,
        sdk,
        account,
        rpc,
        this.now,
        credential,
      );
      opened = session;
      await session.account(); // Validate authentic account reads before advertising readiness.
      input.signal?.removeEventListener("abort", abort);
      return session;
    } catch (error) {
      input.signal?.removeEventListener("abort", abort);
      await rpc?.close().catch(() => undefined);
      try {
        sdk?.close();
      } catch {
        /* Only normalized errors cross the provider boundary. */
      }
      throw sanitizedBrokerError(error);
    }
  }
}

class MetaApiReadSession implements BrokerReadSession {
  readonly execution: MetaApiExecutionAdapter;
  private closed = false;
  private stream: MetaApiStreamPort | undefined;
  private readonly subscriptions = new Map<string, { instrumentId: string; references: number }>();
  private readonly listeners = new Set<BrokerListener>();
  private subscriptionQueue: Promise<void> = Promise.resolve();
  constructor(
    readonly accountId: string,
    private readonly sdk: MetaApiSdkPort,
    private readonly accountPort: MetaApiAccountPort,
    private readonly rpc: MetaApiRpcPort,
    private readonly now: () => Date,
    private readonly credential: string,
  ) {
    this.execution = new MetaApiExecutionAdapter(accountId, rpc, credential);
  }
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new BrokerProviderError("DISCONNECTED");
    try {
      const result = await operation();
      const encoded = JSON.stringify(result);
      if (encoded?.includes(this.credential)) throw new BrokerProviderError("INVALID_RESPONSE");
      if (this.closed) throw new BrokerProviderError("DISCONNECTED");
      return result;
    } catch (error) {
      throw sanitizedBrokerError(error);
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.subscriptionQueue.then(operation);
    this.subscriptionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  account() {
    return this.read(async () =>
      normalizeAccount(
        await this.rpc.getAccountInformation(),
        this.accountId,
        this.now().toISOString(),
      ),
    );
  }
  positionHistory(positionId: string) {
    return this.read(async () => {
      if (!this.rpc.getDealsByPosition) throw new BrokerProviderError("UNAVAILABLE");
      return normalizePositionHistory(
        await this.rpc.getDealsByPosition(positionId),
        this.accountId,
        positionId,
      );
    });
  }
  positions() {
    return this.read(async () =>
      normalizePositions(await this.rpc.getPositions(), this.accountId, this.now().toISOString()),
    );
  }
  orders() {
    return this.read(async () =>
      normalizeOrders(await this.rpc.getOrders(), this.accountId, this.now().toISOString()),
    );
  }
  symbols() {
    return this.read(async () => {
      const parsed = z
        .array(z.string().min(1).max(128))
        .max(10000)
        .safeParse(await this.rpc.getSymbols());
      if (!parsed.success) throw new BrokerProviderError("INVALID_RESPONSE");
      return [...new Set(parsed.data)].sort();
    });
  }
  specification(symbol: string) {
    return this.read(async () =>
      normalizeSpecification(
        await this.rpc.getSymbolSpecification(symbol),
        this.accountId,
        symbol,
        this.now().toISOString(),
      ),
    );
  }
  quote(symbol: string, instrumentId: string) {
    return this.read(async () =>
      normalizeQuote(
        await this.rpc.getSymbolPrice(symbol, false),
        this.accountId,
        symbol,
        instrumentId,
        this.now().toISOString(),
      ),
    );
  }
  preflight(rawAction: FinancialAction) {
    return this.read(async () => {
      const action = FinancialActionSchema.parse(rawAction);
      if (action.accountId !== this.accountId || action.provider !== "metaapi")
        throw new BrokerProviderError("INVALID_REQUEST");
      const [information, positions, orders, rawSpec, rawPrice] = await Promise.all([
        this.account(),
        this.positions(),
        this.orders(),
        this.rpc.getSymbolSpecification(action.brokerSymbol),
        this.rpc.getSymbolPrice(action.brokerSymbol, false),
      ]);
      const observedAt = this.now().toISOString();
      const specification = normalizeSpecification(
        rawSpec,
        this.accountId,
        action.brokerSymbol,
        observedAt,
      );
      const quote = normalizeQuote(
        rawPrice,
        this.accountId,
        action.brokerSymbol,
        action.instrumentId,
        observedAt,
      );
      const rawTick = z
        .object({ lossTickValue: z.unknown().optional() })
        .parse(rawPrice).lossTickValue;
      const rawContract = z
        .object({ contractSize: z.unknown().optional() })
        .parse(rawSpec).contractSize;
      let proposedMargin: string | null = null;
      if (action.operation === "OPEN" || action.operation === "MODIFY_ORDER") {
        if (this.rpc.calculateMargin) {
          const order =
            action.operation === "MODIFY_ORDER"
              ? orders.find(
                  (item) => item.id === action.orderId && item.symbol === action.brokerSymbol,
                )
              : undefined;
          const side = action.operation === "OPEN" ? action.side : order?.side;
          if (!side) throw new BrokerProviderError("INVALID_REQUEST");
          const entry = action.price ?? (side === "BUY" ? quote.ask : quote.bid);
          const calculated = z.object({ margin: z.unknown() }).parse(
            await this.rpc.calculateMargin({
              symbol: action.brokerSymbol,
              type: side === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
              volume: brokerSdkNumber(action.volume),
              openPrice: brokerSdkNumber(entry),
            }),
          );
          proposedMargin = normalizeBrokerDecimal(calculated.margin);
        }
      } else proposedMargin = "0";
      const side = action.operation === "OPEN" ? action.side : null;
      const symbolTradingAllowed =
        specification.tradeMode === "SYMBOL_TRADE_MODE_FULL" ||
        (action.operation !== "OPEN" &&
          specification.tradeMode === "SYMBOL_TRADE_MODE_CLOSEONLY") ||
        (side === "BUY" && specification.tradeMode === "SYMBOL_TRADE_MODE_LONGONLY") ||
        (side === "SELL" && specification.tradeMode === "SYMBOL_TRADE_MODE_SHORTONLY");
      return FinancialRiskFactsSchema.parse({
        version: 1,
        accountId: this.accountId,
        instrumentId: action.instrumentId,
        brokerSymbol: action.brokerSymbol,
        currency: information.currency,
        connected: this.accountPort.connectionStatus === "CONNECTED",
        tradingAllowed: information.tradingAllowed,
        accountMode: information.accountMode,
        observedAt: information.observedAt,
        equity: information.equity,
        freeMargin: information.freeMargin,
        margin: information.margin,
        quote,
        tickSize: specification.tickSize,
        lossTickValue: rawTick === undefined ? null : normalizeBrokerDecimal(rawTick),
        contractSize: rawContract === undefined ? null : normalizeBrokerDecimal(rawContract),
        profitCurrency: specification.quoteCurrency,
        minVolume: specification.minVolume,
        maxVolume: specification.maxVolume,
        volumeStep: specification.volumeStep,
        digits: specification.digits,
        stopsLevel: specification.stopsLevel,
        symbolTradingAllowed,
        specificationObservedAt: specification.verifiedAt,
        orderTypes: specification.orderTypes,
        partialClose: information.accountMode === "HEDGING",
        proposedMargin,
        openPositions: positions.map(({ id, symbol, side, volume }) => ({
          id,
          symbol,
          side,
          volume,
        })),
        pendingOrders: orders.map(({ id, symbol, side, volume }) => ({ id, symbol, side, volume })),
      });
    });
  }
  candles(input: Parameters<BrokerReadSession["candles"]>[0]) {
    return this.read(async () => {
      if (
        !METAAPI_TIMEFRAMES.some((value) => value === input.timeframe) ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 1000 ||
        (input.before !== undefined &&
          !z.iso.datetime({ offset: true }).safeParse(input.before).success)
      )
        throw new BrokerProviderError("INVALID_REQUEST");
      return normalizeCandles(
        await this.accountPort.getHistoricalCandles(
          input.symbol,
          input.timeframe,
          input.before ? new Date(input.before) : undefined,
          input.limit,
        ),
        this.accountId,
        input.symbol,
        input.instrumentId,
        input.timeframe,
        this.now().toISOString(),
      );
    });
  }
  async capabilities() {
    const state = await this.account();
    return TradingCapabilitiesSchema.parse({
      version: 1,
      provider: "metaapi",
      accountId: this.accountId,
      environment: state.environment,
      accountMode: state.accountMode,
      quotes: true,
      quoteStreaming: true,
      candles: true,
      historicalCandles: true,
      accountEvents: true,
      accountRead: true,
      positionsRead: true,
      ordersRead: true,
      symbolSpecifications: true,
      operations: [
        ...(this.rpc.createMarketBuyOrder && this.rpc.createMarketSellOrder ? ["OPEN"] : []),
        ...(this.rpc.modifyPosition ? ["MODIFY_PROTECTION"] : []),
        ...(this.rpc.closePosition ? ["CLOSE_POSITION"] : []),
        ...(this.rpc.cancelOrder ? ["CANCEL_ORDER"] : []),
      ],
      orderTypes: [
        ...(this.rpc.createMarketBuyOrder && this.rpc.createMarketSellOrder ? ["MARKET"] : []),
        ...(this.rpc.createLimitBuyOrder && this.rpc.createLimitSellOrder ? ["LIMIT"] : []),
        ...(this.rpc.createStopBuyOrder && this.rpc.createStopSellOrder ? ["STOP"] : []),
      ],
      partialClose: state.accountMode === "HEDGING" && !!this.rpc.closePositionPartially,
      protectiveStops: !!this.rpc.modifyPosition,
      nativeOco: false,
      clientReferences: !!this.rpc.createMarketBuyOrder && !!this.rpc.createMarketSellOrder,
      verifiedAt: state.observedAt,
      revision: "metaapi-execution:v1",
    });
  }
  async subscribe(
    symbols: Array<{ symbol: string; instrumentId: string }>,
    emit: (event: BrokerEvent) => void,
  ) {
    return this.serialize(() =>
      this.read(async () => {
        if (symbols.length > 256 || this.listeners.size >= 256)
          throw new BrokerProviderError("INVALID_REQUEST");
        const identities = new Map(symbols.map((entry) => [entry.symbol, entry.instrumentId]));
        for (const [symbol, instrumentId] of identities) {
          const existing = this.subscriptions.get(symbol);
          if (existing && existing.instrumentId !== instrumentId)
            throw new BrokerProviderError("INVALID_REQUEST");
        }
        const stream = this.stream ?? this.accountPort.getStreamingConnection();
        this.stream = stream;
        const listener = new BrokerListener(
          this.accountId,
          identities,
          (event) => {
            if (JSON.stringify(event).includes(this.credential)) {
              emit({
                type: "connection_changed",
                accountId: this.accountId,
                connected: false,
                receivedAt: this.now().toISOString(),
              });
              return;
            }
            emit(event);
          },
          this.now,
        );
        stream.addSynchronizationListener(listener);
        this.listeners.add(listener);
        const acquired: string[] = [];
        try {
          await stream.connect();
          await stream.waitSynchronized({ timeoutInSeconds: 20 });
          for (const [symbol, instrumentId] of identities) {
            const existing = this.subscriptions.get(symbol);
            if (!existing) await stream.subscribeToMarketData(symbol, [{ type: "quotes" }], 20);
            this.subscriptions.set(symbol, {
              instrumentId,
              references: (existing?.references ?? 0) + 1,
            });
            acquired.push(symbol);
          }
        } catch (error) {
          stream.removeSynchronizationListener(listener);
          this.listeners.delete(listener);
          await this.release(acquired);
          throw sanitizedBrokerError(error);
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          stream.removeSynchronizationListener(listener);
          this.listeners.delete(listener);
          await this.serialize(() => this.release(acquired));
        };
      }),
    );
  }
  private async release(symbols: string[]) {
    for (const symbol of symbols) {
      const entry = this.subscriptions.get(symbol);
      if (!entry) continue;
      if (--entry.references > 0) continue;
      this.subscriptions.delete(symbol);
      await this.stream
        ?.unsubscribeFromMarketData(symbol, [{ type: "quotes" }])
        .catch(() => undefined);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.subscriptionQueue;
    for (const listener of this.listeners) this.stream?.removeSynchronizationListener(listener);
    this.listeners.clear();
    this.subscriptions.clear();
    await this.stream?.close().catch(() => undefined);
    await this.rpc.close().catch(() => undefined);
    try {
      this.sdk.close();
    } catch {
      /* The trusted host records normalized shutdown state. */
    }
  }
}
