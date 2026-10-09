import { randomUUID } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { BrokerLivePacketSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { requireTradingOwner } from "@rakazo/db";
import type { z } from "zod";
import { BrokerProviderError } from "./metaapi-normalize.js";

/** Same authenticated RPC/event transport; this never opens a provider socket. */
export async function* followBrokerData(input: {
  prisma: PrismaClient;
  realtime: RealtimeFanout;
  ownerUserId: string;
  accountId: string;
  instrumentIds: string[];
  signal?: AbortSignal;
  stillAuthorized?: () => Promise<boolean>;
}): AsyncGenerator<z.infer<typeof BrokerLivePacketSchema>> {
  await requireTradingOwner(input.prisma, input.ownerUserId);
  const connection = await input.prisma.tradingConnection.findFirst({
    where: {
      id: input.accountId,
      ownerUserId: input.ownerUserId,
      revokedAt: null,
    },
  });
  if (!connection) throw new BrokerProviderError("DISCONNECTED");
  const ids = [...new Set(input.instrumentIds)];
  if (ids.length > 16) throw new BrokerProviderError("INVALID_REQUEST");
  const count = await input.prisma.brokerInstrument.count({
    where: { accountId: input.accountId, active: true, id: { in: ids } },
  });
  if (count !== ids.length) throw new BrokerProviderError("INVALID_REQUEST");
  const subscriptions = ids.map((instrumentId) => ({
    id: randomUUID(),
    accountId: input.accountId,
    ownerUserId: input.ownerUserId,
    instrumentId,
    expiresAt: new Date(Date.now() + 15000),
  }));
  await input.prisma.brokerMarketSubscription.createMany({ data: subscriptions });
  const queue = new Map<string, z.infer<typeof BrokerLivePacketSchema>>();
  let wake: (() => void) | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    unsubscribe = await input.realtime.subscribe(`broker:${input.accountId}`, (raw) => {
      try {
        const parsed = BrokerLivePacketSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        for (const event of parsed.data.events) {
          if (
            (event.type === "quote" ? event.quote.accountId : event.accountId) !== input.accountId
          )
            continue;
          if (event.type === "quote" && !ids.includes(event.quote.instrumentId)) continue;
          const key =
            event.type === "quote"
              ? event.quote.instrumentId
              : event.type === "account_changed"
                ? `account:${event.kind}`
                : "connection";
          if (queue.size < 32 || queue.has(key))
            queue.set(key, { generation: parsed.data.generation, events: [event] });
        }
        wake?.();
      } catch {
        /* Discard malformed transport packets without exposing payloads. */
      }
    });
  } catch (error) {
    await input.prisma.brokerMarketSubscription.deleteMany({
      where: { id: { in: subscriptions.map((row) => row.id) } },
    });
    throw error;
  }
  const abort = () => wake?.();
  input.signal?.addEventListener("abort", abort);
  let checkedAt = 0;
  try {
    while (!input.signal?.aborted) {
      if (Date.now() - checkedAt >= 5000) {
        if (input.stillAuthorized && !(await input.stillAuthorized()))
          throw new BrokerProviderError("DISCONNECTED");
        await requireTradingOwner(input.prisma, input.ownerUserId);
        const active = await input.prisma.tradingConnection.findFirst({
          where: {
            id: input.accountId,
            ownerUserId: input.ownerUserId,
            revokedAt: null,
            credentialVersion: connection.credentialVersion,
          },
        });
        if (!active) throw new BrokerProviderError("DISCONNECTED");
        await input.prisma.brokerMarketSubscription.updateMany({
          where: { id: { in: subscriptions.map((row) => row.id) } },
          data: { expiresAt: new Date(Date.now() + 15000) },
        });
        checkedAt = Date.now();
      }
      const lease = await input.prisma.brokerSessionLease.findUnique({
        where: { accountId: input.accountId },
      });
      for (const [key, packet] of queue) {
        queue.delete(key);
        if (
          lease?.generation === packet.generation &&
          lease.expiresAt &&
          lease.expiresAt > new Date()
        )
          yield packet;
      }
      if (lease?.generation && lease.expiresAt && lease.expiresAt > new Date())
        yield { generation: lease.generation, events: [] };
      if (queue.size) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, 5000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
        if (input.signal?.aborted) wake();
      });
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    try {
      await unsubscribe?.();
    } finally {
      await input.prisma.brokerMarketSubscription.deleteMany({
        where: { id: { in: subscriptions.map((row) => row.id) } },
      });
    }
  }
}
