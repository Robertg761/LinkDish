import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import {
  AUTO_APPLY_UPDATE_AFTER_MS,
  getAppUpdateSnapshot,
  holdAutoApplyUpdate,
  markUpdateReady,
  MAX_REGISTER_ATTEMPTS,
  REGISTER_RETRY_MS,
  resetAppUpdateForTests,
  shouldAutoApplyUpdate,
  startAppUpdates,
  UNDO_UPDATE_HOLD_MS
} from "../platform/app-update";

import { AppUpdatePrompt } from "./AppUpdatePrompt";

interface RegisterOptions {
  onNeedRefresh?: () => void;
  onRegisterError?: (error: unknown) => void;
  onRegisteredSW?: (url: string, registration: ServiceWorkerRegistration | undefined) => void;
}

const pwa = vi.hoisted(() => ({
  options: null as RegisterOptions | null,
  registerSW: vi.fn(),
  updateSW: vi.fn()
}));

vi.mock("virtual:pwa-register", () => ({
  registerSW: (options: RegisterOptions) => {
    pwa.options = options;
    pwa.registerSW(options);
    return pwa.updateSW;
  }
}));

const Navigator: React.FC = () => {
  const navigate = useNavigate();

  return (
    <button onClick={() => void navigate("/plan")} type="button">
      Go to plan
    </button>
  );
};

const renderPrompt = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <AppUpdatePrompt />
        <Navigator />
      </ToastProvider>
    </MemoryRouter>
  );

const register = async () => {
  await act(async () => {
    await startAppUpdates();
  });
};

describe("app update prompt", () => {
  beforeEach(() => {
    resetAppUpdateForTests();
    pwa.options = null;
    pwa.registerSW.mockReset();
    pwa.updateSW.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
  });

  afterEach(() => {
    resetAppUpdateForTests();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("registers the service worker once, in prompt mode", async () => {
    await register();
    await register();

    expect(pwa.registerSW).toHaveBeenCalledTimes(1);
    expect(pwa.options?.onNeedRefresh).toEqual(expect.any(Function));
  });

  it("does nothing where service workers are unavailable", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    await register();

    expect(pwa.registerSW).not.toHaveBeenCalled();
  });

  it("offers Reload when a new version is waiting and applies it", async () => {
    renderPrompt();
    await register();

    act(() => {
      pwa.options?.onNeedRefresh?.();
    });

    expect(await screen.findByText("A fresh version of LinkDish is ready")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await Promise.resolve();
    });

    expect(pwa.updateSW).toHaveBeenCalledWith(true);
    expect(getAppUpdateSnapshot().applying).toBe(true);
    expect(screen.queryByText("A fresh version of LinkDish is ready")).not.toBeInTheDocument();
  });

  it("applies an ignored update on the next navigation", async () => {
    renderPrompt();
    await register();

    act(() => {
      markUpdateReady(Date.now() - AUTO_APPLY_UPDATE_AFTER_MS - 1);
    });
    expect(shouldAutoApplyUpdate()).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to plan" }));
      await Promise.resolve();
    });

    expect(pwa.updateSW).toHaveBeenCalledWith(true);
  });

  it("waits a while before applying an update on navigation", async () => {
    renderPrompt();
    await register();

    act(() => {
      markUpdateReady();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to plan" }));
      await Promise.resolve();
    });

    expect(pwa.updateSW).not.toHaveBeenCalled();
    expect(screen.getByText("A fresh version of LinkDish is ready")).toBeInTheDocument();
  });

  it("does not reload on navigation while an Undo is pending", async () => {
    renderPrompt();
    await register();

    act(() => {
      markUpdateReady(Date.now() - AUTO_APPLY_UPDATE_AFTER_MS - 1);
    });
    // e.g. a recipe was deleted and the page moved on, leaving an in-memory Undo behind.
    holdAutoApplyUpdate(UNDO_UPDATE_HOLD_MS);
    expect(shouldAutoApplyUpdate()).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to plan" }));
      await Promise.resolve();
    });

    expect(pwa.updateSW).not.toHaveBeenCalled();
    expect(shouldAutoApplyUpdate(Date.now() + UNDO_UPDATE_HOLD_MS)).toBe(true);
  });

  describe("when registering the service worker fails", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    const failRegistration = () => {
      act(() => {
        pwa.options?.onRegisterError?.(new TypeError("Failed to fetch"));
      });
    };

    it("registers again as soon as the connection comes back", async () => {
      await register();
      failRegistration();

      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await Promise.resolve();
      });

      expect(pwa.registerSW).toHaveBeenCalledTimes(2);
      // Registered now: no further tries pile up.
      vi.useFakeTimers();
      vi.advanceTimersByTime(REGISTER_RETRY_MS * 2 ** MAX_REGISTER_ATTEMPTS);
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      expect(pwa.registerSW).toHaveBeenCalledTimes(2);
    });

    it("tries again by itself after a while, waiting longer each time, then gives up", async () => {
      vi.useFakeTimers();
      await register();

      for (let attempt = 1; attempt < MAX_REGISTER_ATTEMPTS; attempt += 1) {
        failRegistration();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS * 2 ** (attempt - 1) - 1);
        });
        expect(pwa.registerSW).toHaveBeenCalledTimes(attempt);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(pwa.registerSW).toHaveBeenCalledTimes(attempt + 1);
      }

      // e.g. a private window, where it never works.
      failRegistration();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTER_RETRY_MS * 2 ** MAX_REGISTER_ATTEMPTS);
      });
      expect(pwa.registerSW).toHaveBeenCalledTimes(MAX_REGISTER_ATTEMPTS);
    });

    it("tries again when the update checker itself couldn't be loaded", async () => {
      const load = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
        .mockImplementation(() => import("virtual:pwa-register"));

      await act(async () => {
        await startAppUpdates(load);
      });
      expect(pwa.registerSW).not.toHaveBeenCalled();

      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(load).toHaveBeenCalledTimes(2);
      expect(pwa.registerSW).toHaveBeenCalledOnce();
    });
  });

  it("checks for new versions hourly in long-lived tabs", async () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue(undefined);
    await register();

    pwa.options?.onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    vi.advanceTimersByTime(60 * 60_000);

    expect(update).toHaveBeenCalledTimes(1);
  });
});
