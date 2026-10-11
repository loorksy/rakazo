import { marketPinDecision, type PinnedMarket } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

type PinClient = Pick<PrismaClient, "tradingRunMarket">;

export async function readRunMarket(
  prisma: PinClient,
  runId: string,
): Promise<PinnedMarket | null> {
  const row = await prisma.tradingRunMarket.findUnique({ where: { runId } });
  if (!row) return null;
  return {
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    brokerSymbol: row.brokerSymbol,
    provider: row.provider,
  };
}

export async function pinRunMarket(
  prisma: PinClient,
  input: PinnedMarket & { runId: string; supplementary: boolean },
): Promise<
  { ok: true; market: PinnedMarket; supplementary: boolean } | { ok: false; message: string }
> {
  return prisma.tradingRunMarket
    .findUnique({ where: { runId: input.runId } })
    .then(async (existing) => {
      const decision = marketPinDecision(existing, input, input.supplementary);
      if (decision.action === "deny") return { ok: false as const, message: decision.message };
      if (decision.action === "pin") {
        const created = await prisma.tradingRunMarket
          .create({
            data: {
              runId: input.runId,
              accountId: input.accountId,
              instrumentId: input.instrumentId,
              brokerSymbol: input.brokerSymbol,
              provider: input.provider,
            },
          })
          .catch(async () =>
            prisma.tradingRunMarket.findUniqueOrThrow({ where: { runId: input.runId } }),
          );
        if (created.instrumentId !== input.instrumentId && !input.supplementary)
          return {
            ok: false as const,
            message: `This run is pinned to ${created.brokerSymbol}. Do not read ${input.brokerSymbol} unless the read is supplementary cross-market evidence.`,
          };
        return {
          ok: true as const,
          supplementary: created.instrumentId !== input.instrumentId,
          market: {
            accountId: created.accountId,
            instrumentId: created.instrumentId,
            brokerSymbol: created.brokerSymbol,
            provider: created.provider,
          },
        };
      }
      return {
        ok: true as const,
        supplementary: decision.supplementary,
        market: {
          accountId: existing!.accountId,
          instrumentId: existing!.instrumentId,
          brokerSymbol: existing!.brokerSymbol,
          provider: existing!.provider,
        },
      };
    });
}

export async function markRunAccountRead(prisma: PinClient, runId: string): Promise<void> {
  await prisma.tradingRunMarket.updateMany({ where: { runId }, data: { accountRead: true } });
}
