import { createResearchGateway } from "./financial-egress.js";

const gateway = await createResearchGateway({
  privateDirectory: "/var/lib/rakazo-egress/private",
  publicDirectory: "/var/lib/rakazo-egress/public",
});
gateway.listen(8080, "0.0.0.0");
process.on("SIGTERM", () => gateway.close());
