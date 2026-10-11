import { BrokerInstrumentDirectorySchema } from "@rakazo/contracts";
import {
  type BrokerDirectoryRecord,
  type InstrumentSearchResult,
  instrumentDirectoryFresh,
  instrumentExposure,
  searchBrokerDirectory,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { sanitizedBrokerError } from "./metaapi-normalize.js";

type DirectoryClient = Pick<
  PrismaClient,
  "tradingConnection" | "brokerInstrument" | "brokerReadRequest"
>;

function specificationOf(value: unknown): BrokerDirectoryRecord["specification"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    baseCurrency: typeof record.baseCurrency === "string" ? record.baseCurrency : null,
    quoteCurrency: typeof record.quoteCurrency === "string" ? record.quoteCurrency : null,
    description: typeof record.description === "string" ? record.description : null,
  };
}

export async function loadBrokerDirectory(
  prisma: DirectoryClient,
  accountId: string,
  now: Date,
): Promise<{
  provider: string;
  fresh: boolean;
  syncedAt: string | null;
  records: BrokerDirectoryRecord[];
} | null> {
  const connection = await prisma.tradingConnection.findFirst({
    where: { id: accountId, revokedAt: null },
    select: { provider: true, instrumentDirectorySyncedAt: true },
  });
  if (!connection) return null;
  const rows = await prisma.brokerInstrument.findMany({
    where: { accountId, active: true },
    orderBy: { brokerSymbol: "asc" },
    take: 10000,
    select: {
      id: true,
      accountId: true,
      brokerSymbol: true,
      displayName: true,
      verifiedAt: true,
      specification: true,
    },
  });
  return {
    provider: connection.provider,
    fresh: instrumentDirectoryFresh(connection.instrumentDirectorySyncedAt, now),
    syncedAt: connection.instrumentDirectorySyncedAt?.toISOString() ?? null,
    records: rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      brokerSymbol: row.brokerSymbol,
      displayName: row.displayName,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      specification: specificationOf(row.specification),
    })),
  };
}

export function brokerInstrumentDirectory(records: BrokerDirectoryRecord[]) {
  return BrokerInstrumentDirectorySchema.parse(
    records.map((record) => ({
      id: record.id,
      accountId: record.accountId,
      brokerSymbol: record.brokerSymbol,
      displayName: record.displayName,
      verifiedAt: record.verifiedAt,
    })),
  );
}

export function brokerInstrumentSearch(input: {
  accountId: string;
  provider: string;
  query: string;
  records: BrokerDirectoryRecord[];
  limit?: number;
  fresh: boolean;
  syncedAt: string | null;
  unavailable?: boolean;
}): InstrumentSearchResult {
  return searchBrokerDirectory(input);
}

export async function enqueueDirectoryRefresh(
  prisma: Pick<PrismaClient, "brokerReadRequest">,
  ownerUserId: string,
  accountId: string,
  now: Date,
): Promise<void> {
  const pending = await prisma.brokerReadRequest.findFirst({
    where: {
      accountId,
      operation: "instrument_refresh",
      status: { in: ["PENDING", "STARTED"] },
      deadline: { gt: now },
    },
    select: { id: true },
  });
  if (pending) return;
  await prisma.brokerReadRequest.create({
    data: {
      accountId,
      ownerUserId,
      operation: "instrument_refresh",
      parameters: { accountId, operation: "instrument_refresh" },
      deadline: new Date(now.getTime() + 60000),
    },
  });
}

const readArgs = z.object({
  operation: z.string().optional(),
  accountId: z.string().optional(),
  instrumentId: z.string().optional(),
});

/** Tool-facing shape. The chart RPC still receives the persisted directory. */
export async function hydrateSearchResult(
  prisma: Pick<PrismaClient, "brokerInstrument" | "brokerReadRequest">,
  ownerUserId: string,
  result: InstrumentSearchResult,
  signal?: AbortSignal,
): Promise<InstrumentSearchResult> {
  const candidate = result.matches.find((match) => match.instrumentClass === "OTHER");
  if (!candidate || signal?.aborted) return result;
  const stored = await prisma.brokerInstrument.findUnique({
    where: { id: candidate.instrumentId },
    select: { specification: true, verifiedAt: true, brokerSymbol: true },
  });
  const fresh =
    stored?.verifiedAt !== null &&
    stored?.verifiedAt !== undefined &&
    Date.now() - stored.verifiedAt.getTime() < 24 * 60 * 60 * 1000 &&
    stored.specification !== null;
  if (!fresh) {
    const deadline = new Date(Date.now() + 6000);
    const row = await prisma.brokerReadRequest.create({
      data: {
        accountId: result.accountId,
        ownerUserId,
        operation: "specification",
        parameters: {
          accountId: result.accountId,
          instrumentId: candidate.instrumentId,
          operation: "specification",
        },
        deadline,
      },
    });
    const started = Date.now();
    while (Date.now() < deadline.getTime() && !signal?.aborted) {
      const state = await prisma.brokerReadRequest.findUnique({ where: { id: row.id } });
      if (state?.status === "SUCCEEDED" || state?.status === "FAILED") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (Date.now() - started > 6000) break;
    }
  }
  const next = await prisma.brokerInstrument.findUnique({
    where: { id: candidate.instrumentId },
    select: { specification: true, brokerSymbol: true },
  });
  const specification = specificationOf(next?.specification);
  const classified = instrumentExposure(candidate.brokerSymbol, specification ?? undefined);
  return {
    ...result,
    matches: result.matches.map((match) =>
      match.instrumentId === candidate.instrumentId
        ? { ...match, instrumentClass: classified.instrumentClass }
        : match,
    ),
  };
}

export function presentBrokerRead(args: unknown, result: unknown, supplementary = false): unknown {
  const parsed = readArgs.safeParse(args);
  const operation = parsed.success ? parsed.data.operation : undefined;
  const accountId = parsed.success ? (parsed.data.accountId ?? "") : "";
  const instrumentId = parsed.success ? (parsed.data.instrumentId ?? null) : null;
  if (operation === "instruments" && Array.isArray(result)) {
    return {
      accountId,
      count: result.length,
      fresh: true,
      provenance: {
        source: "broker" as const,
        provider: "broker",
        accountId,
        instrumentId: null,
        brokerSymbol: null,
        supplementary,
      },
      guidance:
        "The broker directory is persisted and was not included. Call instrument_search with the owner's words, then use the returned instrumentId.",
    };
  }
  if (operation === "candles" && Array.isArray(result)) {
    return {
      accountId,
      instrumentId,
      candles: result,
      provenance: {
        source: "broker" as const,
        provider: "broker",
        accountId,
        instrumentId,
        brokerSymbol: null,
        supplementary,
      },
    };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.provenance && typeof record.provenance === "object") return result;
  return {
    ...record,
    provenance: {
      source: "broker" as const,
      provider: typeof record.provider === "string" ? record.provider : "broker",
      accountId: typeof record.accountId === "string" ? record.accountId : accountId,
      instrumentId: typeof record.instrumentId === "string" ? record.instrumentId : instrumentId,
      brokerSymbol: typeof record.brokerSymbol === "string" ? record.brokerSymbol : null,
      supplementary,
    },
  };
}

export function brokerReadFailure(error: unknown) {
  const safe = sanitizedBrokerError(error);
  const guidance =
    safe.code === "INVALID_REQUEST"
      ? "Use instrument_search, then the returned instrumentId. A broker symbol is not an instrument id."
      : safe.code === "DISCONNECTED"
        ? "The broker session is disconnected."
        : safe.code === "RATE_LIMITED"
          ? "The broker rate limit was reached."
          : "Broker-native data is temporarily unavailable. Do not replace it with another venue.";
  return {
    error: safe.message,
    code: safe.code,
    brokerNative: true as const,
    substituteVenue: false as const,
    guidance,
  };
}

export function emptyDirectorySearch(input: {
  accountId: string;
  provider: string;
  query: string;
  limit?: number;
}): InstrumentSearchResult {
  return searchBrokerDirectory({
    ...input,
    records: [],
    fresh: false,
    syncedAt: null,
    unavailable: true,
  });
}
