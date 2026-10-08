import { expect, it } from "vitest";
import { createRepos } from "./repos.js";

it("generic Bot creation cannot impersonate server-provisioned financial identity", async () => {
  const repos = createRepos({} as never);
  await expect(
    repos.createBot(
      { userId: "owner", spaceId: "private", email: "owner@example.test", isDeploymentOwner: true },
      {
        name: "Impersonator",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
        spawnKey: "trading:main:v1",
      },
    ),
  ).rejects.toThrow("provisioned by the server");
});
