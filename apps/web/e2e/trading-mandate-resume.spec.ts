import { expect, test } from "@playwright/test";

test("paused simulation mandate exposes exact owner resume", async ({ page }, testInfo) => {
  const envelope = {
    version: 1,
    ownerId: "owner",
    botId: "Gold",
    accountId: "account",
    mode: "SIMULATION",
    expiresAt: "2099-01-01T00:00:00Z",
    allowedInstruments: ["gold"],
    allowedOperations: ["OPEN"],
    maxMissionLoss: "100",
    maxOpenRisk: "40",
    maxRiskPerTrade: "20",
    maxConcurrentPositions: 2,
    maxPendingOrders: 2,
    breachBehavior: "FREEZE",
    expiryBehavior: "FREEZE",
    targetBehavior: "FREEZE",
    currency: "USD",
    allocatedCapital: "2000",
    maxNotional: "10000",
    maxMarginUsagePercent: "50",
    maxDailyLoss: null,
    allowedOrderTypes: ["MARKET"],
    riskIncreasePermissions: [],
    supervisionPositionId: null,
    supervisedOrderIds: [],
    riskCalculationVersion: "stop-loss-v1",
    costReservePerTrade: "1",
  };
  const mandate = {
    id: "mandate",
    goalId: "goal",
    planId: "plan",
    status: "PAUSED",
    revision: 3,
    envelope,
    fingerprint: "a".repeat(64),
    approvedAt: "2026-10-10T00:00:00Z",
    missionPnl: "0",
    expiresAt: envelope.expiresAt,
  };
  let command: unknown;
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: null }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.replace("/rpc/", "");
    let result: unknown = [];
    if (procedure === "trading/missions")
      result = {
        goal: {
          id: "goal",
          status: "PAUSED",
          targetGuaranteed: false,
          goal: {
            version: 1,
            accountId: "account",
            mode: "SIMULATION",
            objectiveType: "ATTEMPT_PROFIT",
            targetProfit: "300",
            currency: "USD",
            startsAt: "2026-10-10T00:00:00Z",
            endsAt: envelope.expiresAt,
            allowedInstruments: ["gold"],
            userObjective: "Research within bounded risk",
            positionId: null,
          },
        },
        plans: [],
        mandates: [mandate],
      };
    if (procedure === "trading/accountGuardrails")
      result = {
        version: 1,
        accountId: "account",
        mode: "SIMULATION",
        maxReservedRisk: "100",
        maxExposure: "10000",
        maxPendingExposure: "10000",
        maxActiveMandates: 2,
        maxDrawdown: null,
        maxMarginUsagePercent: "50",
        autonomousEnabled: true,
        frozen: false,
        revision: 1,
      };
    if (procedure === "trading/connections/list")
      result = [{ id: "account", label: "Fixture account" }];
    if (procedure === "trading/controlMandate") {
      command = route.request().postDataJSON().json;
      result = { ...mandate, status: "ACTIVE", revision: 4 };
    }
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    // Use the same Vite modules and production component as the app; only IO is a fixture.
    const paths = [
      "/node_modules/.vite/deps/react.js",
      "/node_modules/.vite/deps/react-dom_client.js",
      "/src/components/I18nBootstrap.tsx",
      "/src/components/TradingMandateCard.tsx",
    ];
    const [react, dom, i18n, card] = await Promise.all(paths.map((path) => import(path)));
    const host = document.createElement("div");
    host.id = "resume-fixture";
    host.style.padding = "24px";
    document.body.append(host);
    dom.default.createRoot(host).render(
      react.default.createElement(
        i18n.I18nBootstrap,
        null,
        react.default.createElement(card.TradingMandateCard, {
          goalId: "goal",
          mandateId: "mandate",
        }),
      ),
    );
  });
  const fixture = page.locator("#resume-fixture");
  await expect(fixture.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  const path = testInfo.outputPath("trading-resume.png");
  await fixture.screenshot({ path, animations: "disabled" });
  await testInfo.attach("trading-resume", { path, contentType: "image/png" });
  await fixture.getByRole("button", { name: "Resume", exact: true }).click();
  await expect
    .poll(() => command)
    .toEqual({ id: "mandate", expectedRevision: 3, action: "RESUME" });
  await expect(fixture.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await expect(fixture.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});
