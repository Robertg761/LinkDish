import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HAS_SAVED_RECIPE_STORAGE_KEY,
  INSTALL_PROMPT_DISMISSED_STORAGE_KEY,
  markRecipeSaved,
  resetInstallEligibilityForTests
} from "../features/install/install-eligibility";
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

const installTitle = "Add LinkDish to your home screen";

/** What another tab's write looks like to this one. */
const storageEventFromAnotherTab = (key: string | null, newValue: string | null) => {
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
};

describe("InstallPrompt card", () => {
  beforeEach(() => {
    localStorage.clear();
    resetInstallEligibilityForTests();
    captureInstallPrompt();
    resetInstallPromptForTests();
  });

  it("offers install after an extraction even though the event fired before it mounted", async () => {
    localStorage.setItem("linkdish:web:has-extracted-recipe", "true");
    const event = fireBeforeInstallPrompt("dismissed");

    render(<InstallPrompt />);

    const install = screen.getByRole("button", { name: "Install app" });
    expect(install).toBeEnabled();

    await act(async () => {
      fireEvent.click(install);
      await Promise.resolve();
    });

    expect(event.prompt).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument();
  });

  it("stays hidden before the first extraction, without an install event, or once dismissed", () => {
    fireBeforeInstallPrompt();
    const { unmount } = render(<InstallPrompt />);
    expect(screen.queryByText("Add LinkDish to your home screen")).not.toBeInTheDocument();
    unmount();

    localStorage.setItem("linkdish:web:has-extracted-recipe", "true");
    resetInstallPromptForTests();
    const second = render(<InstallPrompt />);
    expect(screen.queryByText("Add LinkDish to your home screen")).not.toBeInTheDocument();
    second.unmount();

    fireBeforeInstallPrompt();
    render(<InstallPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss install tip" }));
    expect(screen.queryByText("Add LinkDish to your home screen")).not.toBeInTheDocument();
    expect(localStorage.getItem("linkdish:web:install-prompt-dismissed")).toBe("true");
  });

  it("appears after the first save while it is already on screen", () => {
    fireBeforeInstallPrompt();
    render(<InstallPrompt />);
    expect(screen.queryByText(installTitle)).not.toBeInTheDocument();

    act(() => {
      markRecipeSaved();
    });

    expect(screen.getByText(installTitle)).toBeInTheDocument();
    expect(localStorage.getItem(HAS_SAVED_RECIPE_STORAGE_KEY)).toBe("true");
  });

  it("follows a first save and a dismissal made in another tab", () => {
    fireBeforeInstallPrompt();
    render(<InstallPrompt />);

    localStorage.setItem(HAS_SAVED_RECIPE_STORAGE_KEY, "true");
    storageEventFromAnotherTab(HAS_SAVED_RECIPE_STORAGE_KEY, "true");
    expect(screen.getByText(installTitle)).toBeInTheDocument();

    localStorage.setItem(INSTALL_PROMPT_DISMISSED_STORAGE_KEY, "true");
    storageEventFromAnotherTab(INSTALL_PROMPT_DISMISSED_STORAGE_KEY, "true");
    expect(screen.queryByText(installTitle)).not.toBeInTheDocument();
  });

  it("stays dismissed for this visit when storage refuses the write", () => {
    localStorage.setItem(HAS_SAVED_RECIPE_STORAGE_KEY, "true");
    fireBeforeInstallPrompt();
    render(<InstallPrompt />);
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss install tip" }));
    setItem.mockRestore();

    expect(screen.queryByText(installTitle)).not.toBeInTheDocument();
    expect(localStorage.getItem(INSTALL_PROMPT_DISMISSED_STORAGE_KEY)).toBeNull();
  });
});
