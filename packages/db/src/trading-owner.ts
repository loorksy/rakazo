import type { Actor } from "@rakazo/contracts";
import { TradingMandateEnvelopeSchema } from "@rakazo/contracts";
import { ownerSessionAllowed } from "@rakazo/core";
import {
  ownerBootstrapProofDigest,
  tradingMandateFingerprint,
} from "@rakazo/core/node/financial-action";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

/** Product initialization is trusted host code, never an RPC or agent tool. */
export async function initializeTradingOwner(prisma: PrismaClient, proof?: string): Promise<void> {
  const proofHash = proof ? ownerBootstrapProofDigest(proof) : null;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(872015)`;
    const humans = await tx.user.findMany({
      where: { NOT: { email: { endsWith: "@messaging.invalid", mode: "insensitive" } } },
      select: { id: true },
      take: 2,
    });
    if (humans.length > 1) throw new Error("Multiple human accounts require operator recovery");
    const existing = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
    const ownerId = existing?.ownerUserId ?? humans[0]?.id ?? null;
    const completed = Boolean(existing?.ownerBootstrapCompleted || ownerId);
    await tx.deploymentSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        singleOwnerEnforced: true,
        ownerUserId: ownerId,
        ownerBootstrapCompleted: completed,
        ownerBootstrapProofHash: completed ? null : proofHash,
        signupsEnabled: !completed && Boolean(proofHash),
        signupPolicyInitialized: true,
      },
      update: {
        singleOwnerEnforced: true,
        ownerUserId: ownerId,
        ownerBootstrapCompleted: completed,
        signupsEnabled: !completed && Boolean(proofHash ?? existing?.ownerBootstrapProofHash),
        ...(completed
          ? { ownerBootstrapProofHash: null }
          : proofHash
            ? { ownerBootstrapProofHash: proofHash }
            : {}),
      },
    });
  });
}

export async function requireTradingOwner(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  userId: string,
): Promise<void> {
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (!settings?.singleOwnerEnforced || !ownerSessionAllowed(settings.ownerUserId, userId))
    throw new IsolationError("Owner session required");
}

/** Called on admitted sessions and at startup; uniqueness is enforced in PostgreSQL. */
export async function provisionTradingOwner(
  prisma: PrismaClient,
  userId: string,
): Promise<{ spaceId: string }> {
  await requireTradingOwner(prisma, userId);
  const { spaceId } = await bootstrapUserSpace(
    prisma,
    { id: userId },
    {
      signupsEnabled: "false",
      signupAllowlist: undefined,
    },
    { claimDeploymentOwner: false },
  );
  const bound = await prisma.deploymentSettings.updateMany({
    where: { id: "default", ownerUserId: userId, singleOwnerEnforced: true },
    data: { ownerSpaceId: spaceId },
  });
  if (bound.count !== 1) throw new IsolationError("Owner changed during provisioning");
  return { spaceId };
}

/** One private owner environment; a requested foreign/extra Space fails closed. */
export async function requireTradingMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  await requireTradingOwner(prisma, userId);
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (!settings?.ownerSpaceId) throw new IsolationError("Owner environment needs provisioning");
  const actor = await requireMembership(prisma, userId, settings.ownerSpaceId);
  if (requestedSpaceId && requestedSpaceId !== actor.spaceId) throw new IsolationError();
  return actor;
}

/** Market knowledge is universal; account reads are owner-granted or bounded by this Agent's mandate. */
export async function tradingAccountReadAllowed(
  prisma: PrismaClient,
  input: {
    ownerUserId: string;
    botId: string;
    accountId: string;
  },
): Promise<boolean> {
  await requireTradingOwner(prisma, input.ownerUserId);
  const settings = await prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
  const bot = await prisma.bot.findFirst({
    where: {
      id: input.botId,
      userId: input.ownerUserId,
      spaceId: settings.ownerSpaceId ?? "",
      archivedAt: null,
    },
  });
  if (
    !bot ||
    !(await prisma.tradingConnection.findFirst({
      where: { id: input.accountId, ownerUserId: input.ownerUserId, revokedAt: null },
    }))
  )
    return false;
  const access = await prisma.tradingAgentAccountAccess.findUnique({
    where: { botId_accountId: { botId: input.botId, accountId: input.accountId } },
  });
  if (access?.ownerUserId === input.ownerUserId && access.accountRead) return true;
  const mandate = await prisma.tradingMandate.findFirst({
    where: {
      ownerUserId: input.ownerUserId,
      botId: input.botId,
      accountId: input.accountId,
      approvedByUserId: input.ownerUserId,
      approvedAt: { not: null },
      status: "ACTIVE",
      expiresAt: { gt: new Date() },
    },
  });
  const envelope = TradingMandateEnvelopeSchema.safeParse(mandate?.envelope);
  return Boolean(
    mandate &&
      envelope.success &&
      mandate.approvedFingerprint === mandate.fingerprint &&
      mandate.fingerprint === tradingMandateFingerprint(envelope.data),
  );
}

/** Human RPC only; tools and peer messages cannot grant account access. */
export async function setTradingAccountAccess(
  prisma: PrismaClient,
  ownerUserId: string,
  input: {
    botId: string;
    accountId: string;
    accountRead: boolean;
    expectedRevision: number;
  },
) {
  await requireTradingOwner(prisma, ownerUserId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM trading_connections WHERE id = ${input.accountId} FOR UPDATE`;
    const settings = await tx.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } });
    if (
      !(await tx.bot.findFirst({
        where: {
          id: input.botId,
          userId: ownerUserId,
          spaceId: settings.ownerSpaceId ?? "",
          archivedAt: null,
        },
      })) ||
      !(await tx.tradingConnection.findFirst({
        where: { id: input.accountId, ownerUserId, revokedAt: null },
      }))
    )
      throw new IsolationError();
    const key = { botId: input.botId, accountId: input.accountId };
    const current = await tx.tradingAgentAccountAccess.findUnique({
      where: { botId_accountId: key },
    });
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new Error("Account access revision conflict");
    const row = await tx.tradingAgentAccountAccess.upsert({
      where: { botId_accountId: key },
      create: { ...key, ownerUserId, accountRead: input.accountRead },
      update: { accountRead: input.accountRead, revision: { increment: 1 } },
    });
    return {
      botId: row.botId,
      accountId: row.accountId,
      accountRead: row.accountRead,
      revision: row.revision,
    };
  });
}
