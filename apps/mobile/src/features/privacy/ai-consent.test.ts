import { describe, expect, it, vi } from "vitest";

import {
  AiConsentDeclinedError,
  createAiConsentController,
  registerAiConsentHandler,
  requireAiConsent
} from "./ai-consent";

describe("AI data sharing permission", () => {
  it("fails closed without a prompt host", async () => {
    const unregister = registerAiConsentHandler(() => Promise.resolve(true));
    unregister();
    await expect(requireAiConsent()).rejects.toBeInstanceOf(AiConsentDeclinedError);
  });

  it("waits for explicit permission and coalesces simultaneous requests", async () => {
    let decide!: (value: boolean) => void;
    const prompt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        })
    );
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = createAiConsentController({
      read: () => Promise.resolve(null),
      write,
      prompt
    });
    const first = controller();
    const second = controller();
    await Promise.resolve();
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    decide(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith("allowed");
    await expect(controller()).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("remembers permission after restart and lets Account revoke it", async () => {
    let stored = "allowed";
    const prompt = vi.fn().mockResolvedValue(false);
    const controller = createAiConsentController({
      read: () => Promise.resolve(stored),
      write: (value) => {
        stored = value;
        return Promise.resolve();
      },
      prompt
    });
    await expect(controller()).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    await expect(controller(true)).resolves.toBe(false);
    expect(stored).toBe("denied");
    await expect(controller()).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("asks when storage fails and never reuses an old grant after a denial", async () => {
    const controller = createAiConsentController({
      read: vi.fn().mockRejectedValue(new Error("Storage unavailable")),
      write: vi.fn().mockRejectedValue(new Error("Storage unavailable")),
      prompt: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    });
    await expect(controller()).resolves.toBe(true);
    await expect(controller(true)).resolves.toBe(false);
    await expect(controller()).resolves.toBe(false);
  });
});
