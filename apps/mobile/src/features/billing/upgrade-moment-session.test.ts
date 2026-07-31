import { describe, expect, it } from "vitest";

import { createUpgradeMomentSessionGate } from "./upgrade-moment-session";

describe("createUpgradeMomentSessionGate", () => {
  it("allows each trigger once per session", () => {
    const gate = createUpgradeMomentSessionGate();

    expect(gate.shouldOpen("save_limit", null)).toBe(true);
    expect(gate.shouldOpen("save_limit", null)).toBe(false);
    expect(gate.shouldOpen("share_to_family_no_plan", null)).toBe(true);
  });

  it("does not stack while another trigger is active", () => {
    const gate = createUpgradeMomentSessionGate();

    expect(gate.shouldOpen("save_limit", "fourth_import_monthly")).toBe(false);
    expect(gate.shouldOpen("save_limit", null)).toBe(true);
  });
});
