// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  revoke: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { trading: { connections: api } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Field: (props: ComponentProps<"div">) => <div {...props} />,
  FieldLabel: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { TradingConnectionsPanel } from "./TradingConnectionsPanel";

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.resetAllMocks();
});
async function render(accounts: unknown[] = []) {
  api.list.mockResolvedValue(accounts);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<TradingConnectionsPanel />));
}
async function fill(label: string, value: string) {
  const target = [...host.querySelectorAll("label")].find((item) => item.textContent === label);
  const input = target?.htmlFor ? document.getElementById(target.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
describe("broker connection settings", () => {
  it("shows broker accounts immediately and the empty state when none are saved", async () => {
    await render();
    expect(api.list).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("No broker accounts connected");
    expect(host.querySelector("form")).not.toBeNull();
  });
  it("masks the token and clears it after an accepted save without browser persistence", async () => {
    await render();
    api.save.mockResolvedValue({ id: "fixture-account" });
    await fill("Account name", "Fixture");
    await fill("MetaApi account ID", "fixture-remote");
    const token = await fill("API token", "fixture-only-sentinel");
    expect(token.type).toBe("password");
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(api.save).toHaveBeenCalledWith({
      label: "Fixture",
      providerAccountId: "fixture-remote",
      region: undefined,
      token: "fixture-only-sentinel",
    });
    expect(token.value).toBe("");
    expect(JSON.stringify(localStorage)).not.toContain("fixture-only-sentinel");
  });
  it("shows connection state and revokes only the selected durable account", async () => {
    await render([
      {
        id: "fixture-account",
        label: "Fixture",
        state: "CONNECTED",
        environment: "DEMO",
        currency: "USD",
      },
    ]);
    api.revoke.mockResolvedValue({ ok: true });
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "Disconnect",
    );
    expect(host.textContent).toContain("1 connected");
    expect(host.textContent).toContain("MetaApi");
    expect(host.textContent).toContain("CONNECTED");
    expect(host.textContent).toContain("DEMO");
    expect(host.textContent).toContain("USD");
    await act(async () => button?.click());
    expect(api.revoke).toHaveBeenCalledWith({ accountId: "fixture-account" });
  });
});
