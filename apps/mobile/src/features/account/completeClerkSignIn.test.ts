import { describe, expect, it, vi } from "vitest";

import { activateClerkSignIn } from "./completeClerkSignIn";

describe("Clerk sign-in completion", () => {
  it("does not activate a session after provider cancellation", async () => {
    const setActive = vi.fn();
    expect(await activateClerkSignIn({ createdSessionId: null, setActive })).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });
  it("rejects incomplete signup and MFA instead of reporting success", async () => {
    await expect(
      activateClerkSignIn({ createdSessionId: null, signUp: { status: "missing_requirements" } })
    ).rejects.toThrow("Additional verification");
    await expect(
      activateClerkSignIn({ createdSessionId: null, signIn: { status: "needs_second_factor" } })
    ).rejects.toThrow("Additional verification");
  });
  it("waits for activation and propagates activation failures", async () => {
    const setActive = vi.fn().mockRejectedValue(new Error("Session expired"));
    await expect(
      activateClerkSignIn({ createdSessionId: "sess_example", setActive })
    ).rejects.toThrow("Session expired");
    expect(setActive).toHaveBeenCalledWith({ session: "sess_example" });
    setActive.mockResolvedValue(undefined);
    expect(await activateClerkSignIn({ createdSessionId: "sess_example", setActive })).toBe(true);
  });
});
