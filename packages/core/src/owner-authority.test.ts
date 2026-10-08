import { describe, expect, it } from "vitest";
import {
  ownerBootstrapAdmission,
  ownerSessionAllowed,
  TRADING_AGENT_OPERATING_CONTRACT,
} from "./owner-authority.js";

describe("single-owner admission contract", () => {
  it("never grants a session to an unclaimed, missing, or different owner", () => {
    expect(ownerSessionAllowed(null, "user")).toBe(false);
    expect(ownerSessionAllowed("", "")).toBe(false);
    expect(ownerSessionAllowed("owner", "peer")).toBe(false);
    expect(ownerSessionAllowed("owner", "owner")).toBe(true);
  });
  it("requires protected proof and no previous ownership for bootstrap", () => {
    const input = {
      ownerId: null,
      bootstrapCompleted: false,
      existingHumanCount: 0,
      validBootstrapProof: true,
    };
    expect(ownerBootstrapAdmission(input)).toBe("CLAIM");
    for (const change of [
      { ownerId: "owner" },
      { bootstrapCompleted: true },
      { existingHumanCount: 1 },
      { validBootstrapProof: false },
    ]) {
      expect(ownerBootstrapAdmission({ ...input, ...change })).toBe("DENY");
    }
  });
  it("does not reopen bootstrap when the original owner user row is missing", () => {
    expect(
      ownerBootstrapAdmission({
        ownerId: "deleted-owner",
        bootstrapCompleted: true,
        existingHumanCount: 0,
        validBootstrapProof: true,
      }),
    ).toBe("DENY");
    expect(
      ownerBootstrapAdmission({
        ownerId: null,
        bootstrapCompleted: true,
        existingHumanCount: 0,
        validBootstrapProof: true,
      }),
    ).toBe("DENY");
  });
  it("keeps product guidance independent of any fixed strategy", () => {
    expect(TRADING_AGENT_OPERATING_CONTRACT).toContain("WAIT");
    expect(TRADING_AGENT_OPERATING_CONTRACT).toContain("structured");
    expect(TRADING_AGENT_OPERATING_CONTRACT).toContain("Simulation");
  });
});
