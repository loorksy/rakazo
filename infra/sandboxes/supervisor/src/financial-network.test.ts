import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { trustedResearchGateway } from "./financial-network.js";

function fixture() {
  return {
    Image: "trusted-image",
    Config: {
      Labels: {
        "rakazo.financialContainment": "financial-egress-v1",
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
});
