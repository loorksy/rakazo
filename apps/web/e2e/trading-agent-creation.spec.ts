import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

/** UI intent fixture only; actual ownership and financial admission have PostgreSQL coverage. */
test("owner names a professional Agent without a role taxonomy or mandatory master", async ({
  page,
}, testInfo) => {
  const created: unknown[] = [];
  await page.route("**/api/auth/**", async (route) => {
    const capability = route.request().url().includes("capabilities");
    await route.fulfill({
      json: capability
        ? { emailPassword: true, signupsEnabled: false, socialProviders: [], billing: false }
        : {
            session: {
              id: "fixture-session",
              userId: "fixture-owner",
              expiresAt: "2099-01-01T00:00:00Z",
            },
            user: {
              id: "fixture-owner",
              name: "Owner",
              email: "owner@example.test",
              emailVerified: true,
            },
          },
    });
  });
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.replace("/rpc/", "");
    const result =
      procedure === "me"
        ? {
            needsModel: false,
            defaultProvider: "scripted",
            defaultModel: "fixture",
            billingEnabled: false,
          }
        : procedure === "integrationSetup/get"
          ? { needsSetup: false }
          : procedure === "bots/create"
            ? { id: "fixture-gold", name: "Gold" }
            : [];
    if (procedure === "bots/create") created.push(route.request().postDataJSON().json);
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Create Agent" })).toBeVisible();
  expect(created).toHaveLength(0);
  await page.getByLabel("Name", { exact: true }).fill("Gold");
  await page
    .getByLabel("Focus", { exact: true })
    .fill("Analyze gold and give recommendations. Do not trade.");
  await captureScreenshot(page, testInfo, "trading-create-agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toEqual({
    name: "Gold",
    description: "Analyze gold and give recommendations. Do not trade.",
    notifyOnFinish: true,
  });
  await expect(page).toHaveURL(/\/app\/fixture-gold$/);
});
