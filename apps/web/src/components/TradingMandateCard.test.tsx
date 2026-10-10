// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  missions: vi.fn(),
  liveSettings: vi.fn(async () => ({ enabled: false })),
  setLiveEnabled: vi.fn(async () => ({ enabled: true })),
  accountGuardrails: vi.fn(),
  resolveMandate: vi.fn(),
  controlMandate: vi.fn(),
  setAccountGuardrails: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { trading: { ...api, connections: { list: api.list } } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { TradingMandateCard } from "./TradingMandateCard";

const envelope = {
  version: 1,
  ownerId: "owner",
  botId: "main",
  accountId: "account",
  mode: "SIMULATION",
  expiresAt: "2026-10-11T10:00:00Z",
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
  status: "AWAITING_APPROVAL",
  revision: 7,
  envelope,
  fingerprint: "a".repeat(64),
  approvedAt: null,
  missionPnl: "0",
  expiresAt: envelope.expiresAt,
};
let root: Root | undefined;
let host: HTMLDivElement | undefined;
function fixtures(mode = "SIMULATION", status = "AWAITING_APPROVAL") {
  api.missions.mockResolvedValue({
    goal: {
      id: "goal",
      status: "AWAITING_MANDATE_APPROVAL",
      targetGuaranteed: false,
      goal: {
        version: 1,
        accountId: "account",
        mode,
        objectiveType: "ATTEMPT_PROFIT",
        targetProfit: "300",
        currency: "USD",
        startsAt: "2026-10-09T10:00:00Z",
        endsAt: envelope.expiresAt,
        allowedInstruments: ["gold"],
        userObjective: "Attempt a profit within hard limits",
        positionId: null,
      },
    },
    plans: [],
    mandates: [{ ...mandate, status, envelope: { ...envelope, mode } }],
  });
  api.accountGuardrails.mockResolvedValue({
    version: 1,
    accountId: "account",
    mode,
    autonomousEnabled: true,
    frozen: false,
    revision: 1,
    maxReservedRisk: "100",
    maxExposure: "10000",
    maxPendingExposure: "10000",
    maxActiveMandates: 1,
    maxDrawdown: null,
    maxMarginUsagePercent: "50",
  });
  api.list.mockResolvedValue([{ id: "account", label: "Fixture account" }]);
}
async function render(readOnly = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(<TradingMandateCard goalId="goal" mandateId="mandate" readOnly={readOnly} />),
  );
}
function button(text: string) {
  return Array.from(host?.querySelectorAll("button") ?? []).find((row) => row.textContent === text);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.resetAllMocks();
});
it("loads current authority and binds owner approval to the exact server fingerprint/revision", async () => {
  fixtures();
  api.resolveMandate.mockResolvedValue({ ...mandate, status: "ACTIVE", revision: 8 });
  await render();
  expect(host?.textContent).toContain("Fixture account");
  expect(host?.textContent).toContain("not guaranteed");
  await act(async () => button("Approve mandate")?.click());
  expect(api.resolveMandate).toHaveBeenCalledWith({
    id: "mandate",
    expectedRevision: 7,
    fingerprint: "a".repeat(64),
    approve: true,
  });
  expect(button("Pause")).toBeDefined();
  expect(button("Approve mandate")).toBeUndefined();
});
it("bounded LIVE mandate approval does not enable the LIVE product", async () => {
  fixtures("LIVE");
  await render();
  expect(button("Approve mandate")?.disabled).toBe(false);
  await act(async () => button("Approve mandate")?.click());
  expect(api.resolveMandate).toHaveBeenCalledWith(
    expect.objectContaining({ approve: true, fingerprint: mandate.fingerprint }),
  );
  expect(api.setLiveEnabled).not.toHaveBeenCalled();
});
it("does not grant authority from a read-only conversation", async () => {
  fixtures();
  await render(true);
  expect(button("Approve mandate")?.disabled).toBe(true);
  expect(button("Deny")?.disabled).toBe(true);
});
it("keeps authoritative state on conflict rather than inventing a successful approval", async () => {
  fixtures();
  api.resolveMandate.mockRejectedValue(new Error("Revision conflict"));
  await render();
  await act(async () => button("Approve mandate")?.click());
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain("Action rejected");
  expect(host?.textContent).toContain("AWAITING_APPROVAL");
});
it("never approves before separately configured owner account guardrails", async () => {
  fixtures();
  api.accountGuardrails.mockResolvedValue(null);
  await render();
  expect(button("Approve mandate")?.disabled).toBe(true);
  expect(api.setAccountGuardrails).not.toHaveBeenCalled();
});

it("resumes only the exact paused mandate revision without sending an enlarged envelope", async () => {
  fixtures("SIMULATION", "PAUSED");
  api.controlMandate.mockResolvedValue({ ...mandate, status: "ACTIVE", revision: 8 });
  await render();
  expect(button("Resume")?.disabled).toBe(false);
  await act(async () => button("Resume")?.click());
  expect(api.controlMandate).toHaveBeenCalledWith({
    id: "mandate",
    expectedRevision: 7,
    action: "RESUME",
  });
  expect(button("Resume")).toBeUndefined();
});
it("keeps resume disabled until the owner separately unfreezes the account", async () => {
  fixtures("SIMULATION", "PAUSED");
  api.accountGuardrails.mockResolvedValue({ ...(await api.accountGuardrails()), frozen: true });
  await render();
  expect(button("Resume")?.disabled).toBe(true);
});

it("never offers resume for a sticky risk-stop outcome", async () => {
  fixtures("SIMULATION", "RISK_STOPPED");
  await render();
  expect(button("Resume")).toBeUndefined();
});
