/**
 * 29.3.3's ESM declaration entry imports extensionless modules under NodeNext.
 * Its exports otherwise degrade to implicit any. This audited, read-only port
 * describes the native Node entry without copying or modifying vendor code.
 */
declare module "metaapi.cloud-sdk/esm-node" {
  import type { MetaApiAccountPort } from "./metaapi-broker.js";
  export default class MetaApi {
    constructor(
      token: string,
      options: {
        application: string;
        region?: string;
        requestTimeout: number;
        connectTimeout: number;
        packetLogger: { enabled: false };
        enableLatencyMonitor: false;
        enableLatencyTracking: false;
      },
    );
    static enableLog4jsLogging(): void;
    metatraderAccountApi: { getAccount(id: string): Promise<MetaApiAccountPort> };
    close(): void;
  }
  export class SynchronizationListener {
    onConnected(instanceIndex: string, replicas: number): Promise<unknown>;
    onDisconnected(instanceIndex: string): Promise<unknown>;
    onSymbolPricesUpdated(
      instanceIndex: string,
      prices: unknown[],
      equity: number,
      margin: number,
      freeMargin: number,
      marginLevel: number,
      accountCurrencyExchangeRate: number,
    ): Promise<unknown>;
    onAccountInformationUpdated(instanceIndex: string, information: unknown): Promise<unknown>;
    onPositionsUpdated(
      instanceIndex: string,
      positions: unknown[],
      removed: string[],
    ): Promise<unknown>;
    onPositionUpdated(instanceIndex: string, position: unknown): Promise<unknown>;
    onPositionRemoved(instanceIndex: string, id: string): Promise<unknown>;
    onPendingOrdersUpdated(
      instanceIndex: string,
      orders: unknown[],
      completed: string[],
    ): Promise<unknown>;
    onPendingOrderUpdated(instanceIndex: string, order: unknown): Promise<unknown>;
    onPendingOrderCompleted(instanceIndex: string, id: string): Promise<unknown>;
  }
}
