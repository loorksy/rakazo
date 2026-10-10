import { FINANCIAL_CONTAINMENT_REVISION } from "@rakazo/core";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { ensureResearchGateway, trustedResearchGateway } from "./financial-network.js";

function fixture() {
  return {
    Image: "trusted-image",
    Config: {
      Labels: {
        "rakazo.financialContainment": FINANCIAL_CONTAINMENT_REVISION,
        "rakazo.researchOwner": "owner",
      },
      Cmd: ["./node_modules/.bin/tsx", "src/financial-egress-entry.ts"],
      WorkingDir: "/app/infra/sandboxes/supervisor",
      Env: ["PATH=/usr/bin", "NODE_VERSION=22"],
    },
    HostConfig: {
      Privileged: false,
      PidMode: "",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
    },
    Mounts: [
      { Name: "rakazo-research-public-owner", Destination: "/var/lib/rakazo-egress/public" },
      { Name: "rakazo-research-private-owner", Destination: "/var/lib/rakazo-egress/private" },
    ],
  };
}
describe("trusted gateway inspection", () => {
  const verified = (value: ReturnType<typeof fixture>) =>
    trustedResearchGateway(
      value as unknown as Docker.ContainerInspectInfo,
      "owner",
      "trusted-image",
    );
  it("accepts the exact isolated research gateway specification", () => {
    expect(verified(fixture())).toBe(true);
  });
  it.each([
    "image",
    "command",
    "owner",
    "privileged",
    "pid",
    "write",
    "caps",
    "privileges",
    "mount",
    "secret",
  ])("rejects altered trusted boundary %s", (change) => {
    const value = fixture();
    if (change === "image") value.Image = "untrusted";
    if (change === "command") value.Config.Cmd = ["sh", "-c", "untrusted script"];
    if (change === "owner") value.Config.Labels["rakazo.researchOwner"] = "peer";
    if (change === "privileged") value.HostConfig.Privileged = true;
    if (change === "pid") value.HostConfig.PidMode = "host";
    if (change === "write") value.HostConfig.ReadonlyRootfs = false;
    if (change === "caps") value.HostConfig.CapDrop = [];
    if (change === "privileges") value.HostConfig.SecurityOpt = [];
    if (change === "mount")
      value.Mounts.push({ Name: "host-socket", Destination: "/var/run/docker.sock" });
    if (change === "secret") value.Config.Env.push("BROKER_TOKEN=fixture-secret-sentinel");
    expect(verified(value)).toBe(false);
  });
  it("rejects a gateway built with an older containment revision", () => {
    const value = fixture();
    value.Config.Labels["rakazo.financialContainment"] = "financial-egress-v1";
    expect(verified(value)).toBe(false);
  });
});

describe("research gateway replacement after an image or revision change", () => {
  function fakeDocker(existing: ReturnType<typeof fixture> | undefined) {
    let current = existing;
    const removed: string[] = [];
    const created: unknown[] = [];
    const healthy = () => ({
      ...fixture(),
      Id: "gateway-id",
      State: { Running: true, Health: { Status: "healthy" } },
    });
    const docker = {
      getContainer: (name: string) => ({
        inspect: async () => {
          if (!current) throw new Error("missing");
          return current;
        },
        remove: async () => {
          removed.push(name);
          current = undefined;
        },
        start: async () => undefined,
      }),
      createNetwork: async () => undefined,
      createVolume: async () => undefined,
      createContainer: async (options: unknown) => {
        created.push(options);
        current = healthy() as unknown as ReturnType<typeof fixture>;
        return docker.getContainer("rakazo-research-owner");
      },
      getNetwork: () => ({
        inspect: async () => ({
          Internal: true,
          EnableIPv6: false,
          Containers: { "gateway-id": {} },
        }),
        connect: async () => undefined,
      }),
    };
    return { docker: docker as unknown as Docker, removed, created };
  }
  it("replaces this owner's stale gateway and keeps its trust volumes", async () => {
    const stale = fixture();
    stale.Image = "previous-image";
    stale.Config.Labels["rakazo.financialContainment"] = "financial-egress-v1";
    const fake = fakeDocker(stale);
    await expect(
      ensureResearchGateway(fake.docker, "owner", "trusted-image", "bot-network"),
    ).resolves.toBe("rakazo-research-public-owner");
    expect(fake.removed).toEqual(["rakazo-research-owner"]);
    expect(fake.created).toHaveLength(1);
  });
  it("never removes a foreign container that squats the gateway name", async () => {
    const foreign = fixture();
    foreign.Config.Labels = {} as typeof foreign.Config.Labels;
    const fake = fakeDocker(foreign);
    await expect(
      ensureResearchGateway(fake.docker, "owner", "trusted-image", "bot-network"),
    ).rejects.toThrow("identity unverified");
    expect(fake.removed).toEqual([]);
    expect(fake.created).toEqual([]);
  });
});
