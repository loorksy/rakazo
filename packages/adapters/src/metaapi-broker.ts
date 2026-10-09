/// <reference path="./metaapi-sdk.d.ts" />
import type { BrokerEvent, BrokerProvider, BrokerReadSession } from "@rakazo/adapter-kit";
import { TradingCapabilitiesSchema } from "@rakazo/contracts";
import MetaApi, { SynchronizationListener } from "metaapi.cloud-sdk/esm-node";
import { z } from "zod";
import {
  BrokerProviderError,
  METAAPI_TIMEFRAMES,
  normalizeAccount,
  normalizeCandles,
  normalizeOrders,
  normalizePositions,
  normalizeQuote,
  normalizeSpecification,
  sanitizedBrokerError,
} from "./metaapi-normalize.js";

/** Narrow injectable SDK port: mutation methods are deliberately absent. */
export interface MetaApiRpcPort {
  connect(): Promise<unknown>;
  waitSynchronized(timeoutSeconds?: number): Promise<unknown>;
  getAccountInformation(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOrders(): Promise<unknown>;
  getSymbols(): Promise<unknown>;
  getSymbolSpecification(symbol: string): Promise<unknown>;
  getSymbolPrice(symbol: string, keepSubscription: boolean): Promise<unknown>;
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
      const session = new MetaApiReadSession(input.accountId, sdk, account, rpc, this.now);
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
  ) {}
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new BrokerProviderError("DISCONNECTED");
    try {
      const result = await operation();
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
      operations: [],
      orderTypes: [],
      partialClose: false,
      protectiveStops: false,
      nativeOco: false,
      clientReferences: false,
      verifiedAt: state.observedAt,
      revision: "metaapi-read:v1",
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
        const listener = new BrokerListener(this.accountId, identities, emit, this.now);
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
