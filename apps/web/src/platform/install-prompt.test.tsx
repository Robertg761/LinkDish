import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallPrompt } from "../features/install/InstallPrompt";

import {
  captureInstallPrompt,
  promptInstall,
  resetInstallPromptForTests,
  useInstallPrompt
} from "./install-prompt";

const fireBeforeInstallPrompt = (outcome: "accepted" | "dismissed" = "accepted") => {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string; platform: string }>;
  };
  event.prompt = vi.fn(() => Promise.resolve());
  Object.defineProperty(event, "userChoice", {
    value: Promise.resolve({ outcome, platform: "web" })
  });

  act(() => {
    window.dispatchEvent(event);
  });

  return event;
};

describe("install prompt store", () => {
  beforeEach(() => {
    localStorage.clear();
    captureInstallPrompt();
    resetInstallPromptForTests();
  });

  it("keeps the early install event for UI that mounts later", async () => {
    const event = fireBeforeInstallPrompt();
    expect(event.defaultPrevented).toBe(true);

    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current).toMatchObject({ canInstall: true, isInstalled: false });

    let outcome = "";
    await act(async () => {
      outcome = await result.current.promptInstall();
    });

    expect(outcome).toBe("accepted");
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ canInstall: false, isInstalled: true });
    await expect(promptInstall()).resolves.toBe("unavailable");
  });

  it("marks the app installed when the browser says so", () => {
    fireBeforeInstallPrompt();
    const { result } = renderHook(() => useInstallPrompt());

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });

    expect(result.current).toMatchObject({ canInstall: false, isInstalled: true });
  });
});

describe("InstallPrompt card", () => {
  beforeEach(() => {
    localStorage.clear();
    captureInstallPrompt();
    resetInstallPromptForTests();
  });

  it("offers install after an extraction even though the event fired before it mounted", async () => {
    localStorage.setItem("linkdish:web:has-extracted-recipe", "true");
    const event = fireBeforeInstallPrompt("dismissed");

    render(<InstallPrompt />);

    const install = screen.getByRole("button", { name: "Install App" });
    expect(install).toBeEnabled();

    await act(async () => {
      fireEvent.click(install);
      await Promise.resolve();
    });

    expect(event.prompt).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Install App" })).not.toBeInTheDocument();
  });

  it("stays hidden before the first extraction, without an install event, or once dismissed", () => {
    fireBeforeInstallPrompt();
    const { unmount } = render(<InstallPrompt />);
    expect(screen.queryByText("Add LinkDish to Home Screen")).not.toBeInTheDocument();
    unmount();

    localStorage.setItem("linkdish:web:has-extracted-recipe", "true");
    resetInstallPromptForTests();
    const second = render(<InstallPrompt />);
    expect(screen.queryByText("Add LinkDish to Home Screen")).not.toBeInTheDocument();
    second.unmount();

    fireBeforeInstallPrompt();
    render(<InstallPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss prompt" }));
    expect(screen.queryByText("Add LinkDish to Home Screen")).not.toBeInTheDocument();
    expect(localStorage.getItem("linkdish:web:install-prompt-dismissed")).toBe("true");
  });
});
