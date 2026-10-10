import { expect, it, vi } from "vitest";
import { provisionTradingOwner } from "./trading-owner.js";

it("owner environment provisioning does not create or privilege an Agent", async () => {
  const bot = { upsert: vi.fn(), create: vi.fn() };
  await expect(
    provisionTradingOwner(
      {
        deploymentSettings: {
          findUnique: async () => ({ singleOwnerEnforced: true, ownerUserId: "owner" }),
        },
        bot,
      } as never,
      "other-owner",
    ),
  ).rejects.toThrow("Owner session required");
  expect(bot.upsert).not.toHaveBeenCalled();
  expect(bot.create).not.toHaveBeenCalled();
});
