import type { Prisma } from "@rakazo/db";

/** Delivery linkage only. Caller persists its logical wake receipt in the same transaction. */
export async function createDurableBotWake(
  tx: Prisma.TransactionClient,
  input: { ownerUserId: string; botId: string; key: string; prompt: string },
): Promise<string | null> {
  const settings = await tx.deploymentSettings.findUnique({ where: { id: "default" } });
  if (settings?.ownerUserId !== input.ownerUserId || !settings.ownerSpaceId) return null;
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, userId: input.ownerUserId, spaceId: settings.ownerSpaceId },
  });
  if (!bot) return null;
  const thread = await tx.thread.upsert({
    where: { botId: bot.id },
    create: { botId: bot.id, userId: input.ownerUserId, spaceId: bot.spaceId },
    update: {},
  });
  if (thread.userId !== input.ownerUserId || thread.spaceId !== bot.spaceId) return null;
  const existing = await tx.run.findUnique({
    where: { spaceId_clientNonce: { spaceId: bot.spaceId, clientNonce: input.key } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const task = await tx.task.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      threadId: thread.id,
      userId: input.ownerUserId,
      status: "queued",
      prompt: input.prompt,
    },
  });
  return (
    await tx.run.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: input.ownerUserId,
        status: "queued",
        trigger: "routine",
        clientNonce: input.key,
      },
      select: { id: true },
    })
  ).id;
}
