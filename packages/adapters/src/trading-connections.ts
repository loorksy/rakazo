import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { BrokerReadCommand } from "@rakazo/contracts";
import {
  BrokerReadCommandSchema,
  TradingConnectionInputSchema,
  TradingConnectionViewSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, requireTradingOwner } from "@rakazo/db";
import { z } from "zod";
import { BrokerProviderError } from "./metaapi-normalize.js";
import { persistPreparedSecret } from "./secret-persistence.js";

export class TradingConnections {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
  ) {}
  async list(ownerUserId: string) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const rows = await this.prisma.tradingConnection.findMany({
      where: { ownerUserId },
      include: { lease: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) =>
      TradingConnectionViewSchema.parse({
        id: row.id,
        label: row.label,
        provider: row.provider,
        providerAccountId: row.providerAccountId,
        region: row.region,
        environment: row.environment,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        state:
          row.revokedAt ||
          !row.lease?.expiresAt ||
          row.lease.expiresAt <= new Date() ||
          row.lease.credentialVersion !== row.credentialVersion
            ? "DISCONNECTED"
            : row.lease.state,
        lastHealthyAt: row.lease?.lastHealthyAt?.toISOString() ?? null,
        failureCode: row.lease?.failureCode ?? null,
      }),
    );
  }
  async save(ownerUserId: string, spaceId: string, raw: unknown) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const input = TradingConnectionInputSchema.parse(raw);
    const existing = await this.prisma.tradingConnection.findUnique({
      where: {
        ownerUserId_provider_providerAccountId: {
          ownerUserId,
          provider: "metaapi",
          providerAccountId: input.providerAccountId,
        },
      },
    });
    if (
      (!existing || existing.revokedAt !== null) &&
      (await this.prisma.tradingConnection.count({ where: { ownerUserId, revokedAt: null } })) >= 32
    )
      throw new BrokerProviderError("INVALID_REQUEST");
    const id = existing?.id ?? randomUUID();
    const stored = await this.secrets.put(
      input.token,
      {
        userId: ownerUserId,
        spaceId,
        operationId: "trading.connection.save",
        traceId: id,
        signal: AbortSignal.timeout(10000),
      },
      { recordId: id },
    );
    await persistPreparedSecret(this.prisma, this.secrets, { id, ciphertext: stored.ref }, () =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;
        if (
          (!existing || existing.revokedAt !== null) &&
          (await tx.tradingConnection.count({ where: { ownerUserId, revokedAt: null } })) >= 32
        )
          throw new BrokerProviderError("INVALID_REQUEST");
        return tx.tradingConnection.upsert({
          where: { id },
          create: {
            id,
            ownerUserId,
            label: input.label,
            providerAccountId: input.providerAccountId,
            region: input.region,
            ciphertext: stored.ref,
          },
          update: {
            label: input.label,
            region: input.region ?? null,
            ciphertext: stored.ref,
            credentialVersion: { increment: 1 },
            revokedAt: null,
            verifiedAt: null,
            capabilities: Prisma.DbNull,
          },
        });
      }),
    );
    return { id };
  }
  async revoke(ownerUserId: string, accountId: string) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const count = await this.prisma.tradingConnection.updateMany({
      where: { id: accountId, ownerUserId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        credentialVersion: { increment: 1 },
        ciphertext: "",
        verifiedAt: null,
      },
    });
    if (!count.count) throw new BrokerProviderError("INVALID_REQUEST");
    return { ok: true as const };
  }
}

/** API/tools enqueue normalized read commands; only the existing Worker owns SDK sessions. */
export async function requestBrokerRead(
  prisma: PrismaClient,
  ownerUserId: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<z.infer<ReturnType<typeof z.json>>> {
  if (signal?.aborted) throw new BrokerProviderError("UNAVAILABLE");
  const command: BrokerReadCommand = BrokerReadCommandSchema.parse(raw);
  await requireTradingOwner(prisma, ownerUserId);
  const connection = await prisma.tradingConnection.findFirst({
    where: { id: command.accountId, ownerUserId, revokedAt: null },
  });
  if (!connection) throw new BrokerProviderError("DISCONNECTED");
  if (
    "instrumentId" in command &&
    !(await prisma.brokerInstrument.findFirst({
      where: { id: command.instrumentId, accountId: command.accountId, active: true },
    }))
  )
    throw new BrokerProviderError("INVALID_REQUEST");
  const deadline = new Date(Date.now() + 25000);
  const row = await prisma.brokerReadRequest.create({
    data: {
      accountId: command.accountId,
      ownerUserId,
      operation: command.operation,
      parameters: command,
      deadline,
    },
  });
  while (Date.now() < deadline.getTime() && !signal?.aborted) {
    const state = await prisma.brokerReadRequest.findUnique({ where: { id: row.id } });
    if (state?.status === "SUCCEEDED") return z.json().parse(state.result);
    if (state?.status === "FAILED")
      throw new BrokerProviderError(
        state.failureCode === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE",
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new BrokerProviderError("UNAVAILABLE");
}
