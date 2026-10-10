import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { BrokerReadCommand } from "@rakazo/contracts";
import {
  BrokerReadCommandSchema,
  TradingConnectionInputSchema,
  TradingConnectionViewSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { listTradingAccountAccess, Prisma, requireTradingOwner } from "@rakazo/db";
import { z } from "zod";
import { BrokerProviderError } from "./metaapi-normalize.js";
import { persistPreparedSecret } from "./secret-persistence.js";

const accountCurrency = z.string().regex(/^[A-Za-z]{3,8}$/);

/** Exact wording the Agent must relay. A missing read grant is not a missing account. */
export function accountCatalogSummary(accounts: ReadonlyArray<{ accountRead: boolean }>): string {
  if (accounts.length === 0) return "No broker account is connected.";
  if (accounts.every((account) => !account.accountRead))
    return "A broker account is connected. This Agent does not have account-read permission.";
  return "This Agent can read the permitted account state.";
}

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
        currency: accountCurrency.safeParse(row.currency).success
          ? row.currency?.toUpperCase()
          : null,
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
  /** Same connections as owner settings. Read and execution are separate and never implied. */
  async agentCatalog(ownerUserId: string, botId: string) {
    const [accounts, access, mandates] = await Promise.all([
      this.list(ownerUserId),
      listTradingAccountAccess(this.prisma, ownerUserId, botId),
      this.prisma.tradingMandate.findMany({
        where: { ownerUserId, botId, status: "ACTIVE", expiresAt: { gt: new Date() } },
        select: { accountId: true },
      }),
    ]);
    const visible = accounts
      .filter((account) => !account.revokedAt)
      .map((account) => {
        const grant = access.find((row) => row.accountId === account.id);
        return {
          id: account.id,
          label: account.label,
          provider: account.provider,
          state: account.state,
          environment: account.environment,
          marketData: true as const,
          accountRead: Boolean(grant?.accountRead || grant?.mandateRead),
          execution: mandates.some((row) => row.accountId === account.id)
            ? ("MANDATE" as const)
            : ("NONE" as const),
        };
      });
    return { summary: accountCatalogSummary(visible), accounts: visible };
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
  /** Owner check that the Worker can read the account. Returns no credential and no positions. */
  async verify(ownerUserId: string, accountId: string, signal?: AbortSignal) {
    await requireTradingOwner(this.prisma, ownerUserId);
    const account = z
      .object({
        environment: z.enum(["DEMO", "REAL"]).optional(),
        currency: z.string().max(8).optional(),
        tradingAllowed: z.boolean().optional(),
      })
      .parse(
        await requestBrokerRead(
          this.prisma,
          ownerUserId,
          { operation: "account", accountId },
          signal,
        ),
      );
    const currency = accountCurrency.safeParse(account.currency);
    await this.prisma.tradingConnection.updateMany({
      where: { id: accountId, ownerUserId, revokedAt: null },
      data: {
        verifiedAt: new Date(),
        ...(account.environment ? { environment: account.environment } : {}),
        ...(currency.success ? { currency: currency.data.toUpperCase() } : {}),
      },
    });
    return {
      accountId,
      environment: account.environment ?? null,
      currency: currency.success ? currency.data.toUpperCase() : null,
      tradingAllowed: account.tradingAllowed ?? null,
      connected: true as const,
    };
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
