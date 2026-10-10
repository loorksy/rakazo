import type Docker from "dockerode";
import { FINANCIAL_EGRESS_REVISION } from "./financial-egress.js";

export const researchGatewayName = (owner: string) => `rakazo-research-${owner}`;
export const researchPublicVolume = (owner: string) => `rakazo-research-public-${owner}`;
export const researchPrivateVolume = (owner: string) => `rakazo-research-private-${owner}`;

/** Uses the supervisor's own trusted image and exposes no mutation or shell control API. */
export async function ensureResearchGateway(
  docker: Docker,
  owner: string,
  image: string,
  networkName: string,
) {
  const name = researchGatewayName(owner);
  let container = docker.getContainer(name);
  let info = await container.inspect().catch(() => undefined);
  if (!info) {
    const uplink = `rakazo-research-uplink-${owner}`;
    await docker
      .createNetwork({ Name: uplink, Driver: "bridge", Labels: { "rakazo.researchOwner": owner } })
      .catch(async () => {
        await docker.getNetwork(uplink).inspect();
      });
    await docker.createVolume({ Name: researchPublicVolume(owner) });
    await docker.createVolume({ Name: researchPrivateVolume(owner) });
    container = await docker.createContainer({
      name,
      Image: image,
      User: "0:0",
      WorkingDir: "/app/infra/sandboxes/supervisor",
      Cmd: ["./node_modules/.bin/tsx", "src/financial-egress-entry.ts"],
      Env: [],
      Labels: {
        "rakazo.researchOwner": owner,
        "rakazo.financialContainment": FINANCIAL_EGRESS_REVISION,
      },
      HostConfig: {
        NetworkMode: uplink,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Memory: 256 * 1024 * 1024,
        NanoCpus: 500000000,
        PidsLimit: 64,
        Mounts: [
          {
            Type: "volume",
            Source: researchPublicVolume(owner),
            Target: "/var/lib/rakazo-egress/public",
          },
          {
            Type: "volume",
            Source: researchPrivateVolume(owner),
            Target: "/var/lib/rakazo-egress/private",
          },
        ],
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=32m" },
      },
      Healthcheck: {
        Test: [
          "CMD",
          "node",
          "-e",
          `fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(d=>process.exit(d.revision==='${FINANCIAL_EGRESS_REVISION}'&&d.readOnly===true?0:1)).catch(()=>process.exit(1))`,
        ],
        Interval: 1000000000,
        Timeout: 2000000000,
        StartPeriod: 3000000000,
        Retries: 3,
      },
    });
    info = await container.inspect();
  }
  if (
    info.Image !== image ||
    info.Config.Labels?.["rakazo.financialContainment"] !== FINANCIAL_EGRESS_REVISION ||
    info.HostConfig.Privileged ||
    info.HostConfig.PidMode === "host" ||
    !info.HostConfig.ReadonlyRootfs ||
    !info.HostConfig.CapDrop?.includes("ALL")
  )
    throw new Error("Research gateway identity unverified");
  if (!info.State.Running) await container.start();
  const network = docker.getNetwork(networkName);
  const isolated = await network.inspect();
  if (!isolated.Internal || isolated.EnableIPv6)
    throw new Error("Financial Computer requires an internal network");
  if (!isolated.Containers?.[info.Id])
    await network.connect({ Container: info.Id, EndpointConfig: { Aliases: ["rakazo-research"] } });
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await container.inspect();
    if (current.State.Health?.Status === "healthy") return researchPublicVolume(owner);
    if (!current.State.Running) throw new Error("Research gateway unavailable");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Research gateway health unverified");
}

/** Live inspection, not a configuration flag or a model review. */
export async function verifyFinancialNetworks(
  docker: Docker,
  owner: string,
  spaceId: string,
  image: string,
) {
  const gateway = await docker
    .getContainer(researchGatewayName(owner))
    .inspect()
    .catch(() => undefined);
  if (
    !gateway ||
    gateway.Image !== image ||
    !gateway.State.Running ||
    gateway.State.Health?.Status !== "healthy" ||
    gateway.Config.Labels?.["rakazo.financialContainment"] !== FINANCIAL_EGRESS_REVISION
  )
    return false;
  const computers = await docker.listContainers({
    all: true,
    filters: { label: ["rakazo.managed=true", `rakazo.spaceId=${spaceId}`] },
  });
  for (const computer of computers) {
    const info = await docker.getContainer(computer.Id).inspect();
    const networks = Object.keys(info.NetworkSettings.Networks ?? {});
    if (
      networks.length !== 1 ||
      info.HostConfig.Privileged ||
      info.HostConfig.PidMode === "host" ||
      !info.HostConfig.CapDrop?.includes("ALL") ||
      !info.HostConfig.SecurityOpt?.includes("no-new-privileges:true") ||
      info.Config.User === "0" ||
      info.Config.User.startsWith("0:")
    )
      return false;
    const network = await docker.getNetwork(networks[0]!).inspect();
    if (!network.Internal || network.EnableIPv6 || !network.Containers?.[gateway.Id]) return false;
    const mounts = info.Mounts;
    if (
      !mounts.some(
        (mount) =>
          mount.Name === researchPublicVolume(owner) &&
          mount.Destination === "/etc/rakazo/research-trust" &&
          !mount.RW,
      ) ||
      mounts.some(
        (mount) =>
          mount.Name === researchPrivateVolume(owner) || mount.Destination.includes("docker.sock"),
      )
    )
      return false;
  }
  return true;
}
