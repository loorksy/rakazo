import { expect, test } from "@playwright/test";

test("owner grants exact Agent account reads and inspects durable journal", async ({
  page,
}, testInfo) => {
  let accountRead = false;
  let revision = 0;
  let command: unknown;
  let journalQuery: unknown;
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.split("/rpc/")[1];
    let result: unknown = null;
    if (procedure === "trading/setAccountAccess") {
      command = route.request().postDataJSON().json;
      accountRead = true;
      revision++;
      result = { botId: "Gold", accountId: "account", accountRead, revision };
    }
    if (procedure === "trading/accountAccess")
      result = [
        {
          botId: "Gold",
          accountId: "account",
          label: "Fixture account",
          accountRead,
          revision,
          mandateRead: false,
        },
      ];
    if (procedure === "trading/journal") {
      journalQuery = route.request().postDataJSON().json;
      result = {
        entries: [
          {
            id: "entry",
            accountId: "account",
            mode: "SIMULATION",
            effectId: null,
            goalId: null,
            mandateId: null,
            event: "MANDATE_RESUMED",
            entry: { expandsAuthority: false },
            createdAt: "2026-10-10T10:00:00Z",
          },
        ],
        nextCursor: null,
      };
    }
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const paths = [
      "/node_modules/.vite/deps/react.js",
      "/node_modules/.vite/deps/react-dom_client.js",
      "/src/components/I18nBootstrap.tsx",
      "/src/components/TradingAccountAccess.tsx",
      "/src/components/TradingJournal.tsx",
    ];
    const [react, dom, i18n, access, journal] = await Promise.all(
      paths.map((path) => import(path)),
    );
    const host = document.createElement("div");
    host.id = "trading-fixture";
    host.style.padding = "24px";
    host.style.maxWidth = "560px";
    document.body.append(host);
    dom.default
      .createRoot(host)
      .render(
        react.default.createElement(
          i18n.I18nBootstrap,
          null,
          react.default.createElement(access.TradingAccountAccess, { botId: "Gold" }),
          react.default.createElement(journal.TradingJournal, { accountId: "account" }),
        ),
      );
  });
  const fixture = page.locator("#trading-fixture");
  await fixture.getByText("Account access", { exact: true }).click();
  const read = fixture.getByRole("switch", { name: "Account read" });
  await expect(read).not.toBeChecked();
  await read.click();
  await expect
    .poll(() => command)
    .toEqual({ botId: "Gold", accountId: "account", accountRead: true, expectedRevision: 0 });
  await expect(read).toBeChecked();
  await fixture.getByText("Journal", { exact: true }).click();
  await expect(fixture.getByText("MANDATE RESUMED", { exact: true })).toBeVisible();
  await expect.poll(() => journalQuery).toEqual({ accountId: "account", limit: 30 });
  await fixture.getByText("MANDATE RESUMED", { exact: true }).click();
  await expect(fixture.locator("pre")).toContainText('"expandsAuthority": false');
  const path = testInfo.outputPath("trading-account-access.png");
  await fixture.screenshot({ path, animations: "disabled" });
  await testInfo.attach("trading-account-access", { path, contentType: "image/png" });
});
