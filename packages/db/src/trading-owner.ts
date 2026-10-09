import type { Actor } from "@rakazo/contracts";
import { BOT_COLORS } from "@rakazo/contracts";
import {
  MAIN_TRADING_AGENT_SPAWN_KEY,
  ownerSessionAllowed,
  TRADING_AGENT_OPERATING_CONTRACT,
} from "@rakazo/core";
import { ownerBootstrapProofDigest } from "@rakazo/core/node/financial-action";
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
): Promise<{ spaceId: string; botId: string }> {
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
  const bot = await prisma.bot.upsert({
    where: { spaceId_spawnKey: { spaceId, spawnKey: MAIN_TRADING_AGENT_SPAWN_KEY } },
    create: {
      spaceId,
      userId,
      name: "Trading Agent",
      title: "Trading Agent",
      color: BOT_COLORS[4],
      spawnKey: MAIN_TRADING_AGENT_SPAWN_KEY,
      pinned: true,
      position: -1,
      instructions: TRADING_AGENT_OPERATING_CONTRACT,
      thread: { create: { spaceId, userId } },
    },
    update: {},
  });
  await prisma.bot.updateMany({
    where: { id: bot.id, color: "blue" },
    data: { color: BOT_COLORS[4] },
  });
  // Recover a missing thread without rewriting user history or instructions.
  await prisma.thread.upsert({
    where: { botId: bot.id },
    create: { botId: bot.id, spaceId, userId },
    update: {},
  });
  const bound = await prisma.deploymentSettings.updateMany({
    where: { id: "default", ownerUserId: userId, singleOwnerEnforced: true },
    data: { ownerSpaceId: spaceId },
  });
  if (bound.count !== 1) throw new IsolationError("Owner changed during provisioning");
  return { spaceId, botId: bot.id };
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
