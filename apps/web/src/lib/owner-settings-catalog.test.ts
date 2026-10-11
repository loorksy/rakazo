import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

/** Production builds keep only this id. A missing catalog entry renders the id itself. */
function productionMessageId(message: string): string {
  return createHash("sha256")
    .update(`${message}\u001f`)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
    .slice(0, 6);
}

const ownerSettingsLabels = [
  "Trading",
  "Deployment",
  "Observability",
  "LIVE",
  "Trading knowledge",
  "Configured",
  "Missing",
  "Containment",
  "Restart required",
  "Broker accounts",
  "No broker accounts connected",
  "Connect MetaApi account",
  "Broker access",
  "Allow account read",
  "Market data",
  "Available",
  "Account balance / equity / margin / positions",
  "Allowed",
  "Not allowed",
  "Execution",
  "No authority",
  "Mandate scope",
  "No broker account connected.",
  "Connect broker account",
  "Could not load broker instruments.",
  "Loading broker accounts…",
  "Disconnected",
  "Computer memory",
  "Maximum memory available to each Agent Computer.",
  "Worker concurrency",
  "Number of background jobs the Worker may process at once.",
  "Environment key",
  "Applies to new Computers",
  "Calendar provider",
  "Financial Modeling Prep",
  "Finnhub",
  "Calendar API key",
  "Write-only. The saved key is never shown again.",
  "Database URL",
  "Postgres password",
  "Authentication secret",
  "Encryption key",
  "Sandbox supervisor token",
  "Screen proxy secret",
  "These deployment checks are read-only. Values are never shown.",
  "Entry timing",
  "Retests",
  "Gold-specific behavior",
  "Crypto context",
  "Index context",
  "Energy context",
  "Only applied to gold instruments",
  "News protection",
  "Rules are selected contextually. They are not all sent on every Agent turn.",
  "Hard safety rules cannot be disabled.",
  "Enabled",
  "{0} contextual trading rules",
  "Loading broker instruments…",
  "No broker instruments.",
  "Calendar connected",
  "Calendar unavailable",
  "Calendar disabled",
];

describe("owner settings catalogs", () => {
  it("resolves production message ids to readable English instead of opaque hashes", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../locales/en/messages.po", import.meta.url)),
      "utf8",
    );
    const messages: Record<string, string> = {};
    for (const message of ownerSettingsLabels) {
      const entry = catalog
        .split("\n\n")
        .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
      expect(entry, message).toBeTruthy();
      const translated = entry?.match(/msgstr "(.*)"/)?.[1];
      expect(translated, message).toBe(message);
      const id = productionMessageId(message);
      expect(id, message).not.toBe(message);
      messages[id] = translated ?? "";
    }
    i18n.load("en", messages);
    i18n.activate("en");
    expect(i18n._(productionMessageId("Trading"))).toBe("Trading");
    expect(i18n._("HZN-sw")).toBe("Trading");
    expect(i18n._("m193Yg")).toBe("Deployment");
    expect(i18n._("5lgEAy")).toBe("Observability");
    expect(i18n._("tFwVfD")).toBe("Trading knowledge");
    expect(i18n._("M1co_O")).toBe("Configured");
    for (const message of ownerSettingsLabels) {
      const id = productionMessageId(message);
      const rendered = message.includes("{0}") ? i18n._({ id, values: { 0: 7 } }) : i18n._(id);
      expect(rendered).toBe(message.includes("{0}") ? message.replace("{0}", "7") : message);
      expect(rendered).not.toBe(id);
    }
  });
});
