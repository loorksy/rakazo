import type { Prisma, PrismaClient } from "./client.js";

export interface BrokerLeaseToken {
  accountId: string;
  holder: string;
  generation: number;
  credentialVersion: number;
}
export class StaleBrokerSessionError extends Error {
  constructor() {
    super("Broker session ownership is stale or revoked");
    this.name = "StaleBrokerSessionError";
  }
}

/** Fixed row lock order is connection -> lease for claim, heartbeat and authoritative writes. */
async function lockConnection(tx: Prisma.TransactionClient, accountId: string) {
  await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${accountId} FOR UPDATE`;
  const connection = await tx.tradingConnection.findUnique({ where: { id: accountId } });
  if (!connection || connection.revokedAt) throw new StaleBrokerSessionError();
  return connection;
}

export async function claimBrokerSession(
  prisma: PrismaClient,
  accountId: string,
  holder: string,
  now = new Date(),
  ttlMs = 30000,
): Promise<BrokerLeaseToken | null> {
  if (!holder || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000)
    throw new Error("Invalid broker lease request");
  return prisma.$transaction(async (tx) => {
    const connection = await lockConnection(tx, accountId);
    const lease = await tx.brokerSessionLease.upsert({
      where: { accountId },
      create: { accountId },
      update: {},
    });
    if (lease.expiresAt && lease.expiresAt > now && lease.holder !== holder) return null;
    const same =
      lease.holder === holder &&
      lease.expiresAt !== null &&
      lease.expiresAt > now &&
      lease.credentialVersion === connection.credentialVersion;
    const next = await tx.brokerSessionLease.update({
      where: { accountId },
      data: {
        holder,
        generation: same ? lease.generation : lease.generation + 1,
        expiresAt: new Date(now.getTime() + ttlMs),
        credentialVersion: connection.credentialVersion,
        ...(!same ? { state: "CONNECTING", failureCode: null } : {}),
      },
    });
    if (!same)
      await tx.brokerReadRequest.updateMany({
        where: { accountId, status: "STARTED" },
        data: { status: "PENDING", claimedGeneration: null },
      }); // Safe reads only, never financial effects.
    return {
      accountId,
      holder,
      generation: next.generation,
      credentialVersion: next.credentialVersion,
    };
  });
}

export async function withBrokerSessionFence<T>(
  prisma: PrismaClient,
  token: BrokerLeaseToken,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  now = new Date(),
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const connection = await lockConnection(tx, token.accountId);
    const lease = await tx.brokerSessionLease.findUnique({ where: { accountId: token.accountId } });
    if (
      !lease ||
      lease.holder !== token.holder ||
      lease.generation !== token.generation ||
      lease.credentialVersion !== token.credentialVersion ||
      connection.credentialVersion !== token.credentialVersion ||
      !lease.expiresAt ||
      lease.expiresAt <= now
    )
      throw new StaleBrokerSessionError();
    return write(tx);
  });
}

export function heartbeatBrokerSession(
  prisma: PrismaClient,
  token: BrokerLeaseToken,
  now = new Date(),
  ttlMs = 30000,
) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000)
    throw new Error("Invalid broker lease request");
  return withBrokerSessionFence(
    prisma,
    token,
    (tx) =>
      tx.brokerSessionLease.update({
        where: { accountId: token.accountId },
        data: { expiresAt: new Date(now.getTime() + ttlMs) },
      }),
    now,
  );
}
export function releaseBrokerSession(
  prisma: PrismaClient,
  token: BrokerLeaseToken,
  now = new Date(),
) {
  return withBrokerSessionFence(
    prisma,
    token,
    (tx) =>
      tx.brokerSessionLease.update({
        where: { accountId: token.accountId },
        data: { holder: null, expiresAt: null, state: "DISCONNECTED" },
      }),
    now,
  );
}
