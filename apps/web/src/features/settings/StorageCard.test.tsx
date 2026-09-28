import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatBytes } from "../data-transfer/device-storage";

import { StorageCard } from "./StorageCard";

import type { LinkDishDbStatus } from "../../storage/linkdish-db";

const db = vi.hoisted(() => ({
  status: { state: "ready" } as LinkDishDbStatus,
  retry: vi.fn(() => Promise.resolve(true))
}));

vi.mock("../../data/storage-status", () => ({
  useLinkDishDbStatus: () => db.status,
  retryLinkDishStorage: db.retry
}));

const counts = { recipes: 24, starters: 3, collections: 4, mealPlanEntries: 9 };

const stubStorage = (storage: Partial<StorageManager> | undefined) => {
  Object.defineProperty(navigator, "storage", { configurable: true, value: storage });
};

describe("StorageCard", () => {
  beforeEach(() => {
    db.status = { state: "ready" };
    db.retry.mockClear();
  });

  afterEach(() => {
    stubStorage(undefined);
    vi.restoreAllMocks();
  });

  it("shows usage, counts, and protects storage on request", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    let persisted = false;
    stubStorage({
      estimate: () => Promise.resolve({ usage: 3_567_000, quota: 2_147_483_648 }),
      persisted: () => Promise.resolve(persisted),
      persist: () => {
        persisted = true;
        return persist();
      }
    });
    render(<StorageCard counts={counts} isFamily={false} />);

    expect(
      await screen.findByText("LinkDish is using 3.4 MB of about 2 GB this browser allows.")
    ).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(screen.getByText("Collections")).toBeInTheDocument();
    expect(
      screen.getByText("Plus 3 starter recipes LinkDish added to get you going.")
    ).toBeInTheDocument();
    expect(screen.getByText("Not protected yet")).toBeInTheDocument();
    expect(screen.getByText(/With Family, recipes you share/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Protect my recipes" }));

    expect(await screen.findByText("Protected")).toBeInTheDocument();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Protect my recipes" })).not.toBeInTheDocument();
  });

  it("explains when the browser says no", async () => {
    stubStorage({
      estimate: () => Promise.resolve({ usage: 1024, quota: 1024 * 1024 }),
      persisted: () => Promise.resolve(false),
      persist: () => Promise.resolve(false)
    });
    render(<StorageCard counts={counts} isFamily />);

    fireEvent.click(await screen.findByRole("button", { name: "Protect my recipes" }));

    expect(await screen.findByText(/Your browser said not yet/u)).toBeInTheDocument();
    expect(screen.getByText(/Recipes you share with your Family household/u)).toBeInTheDocument();
  });

  it("copes with browsers without a storage manager", async () => {
    stubStorage(undefined);
    render(<StorageCard counts={null} isFamily={false} />);

    expect(
      await screen.findByText("This browser doesn't say how much space LinkDish uses.")
    ).toBeInTheDocument();
    expect(screen.getByText(/This browser decides on its own/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect my recipes" })).not.toBeInTheDocument();
    expect(screen.getAllByText("–")).toHaveLength(3);
  });

  it("asks to close other tabs when storage is blocked, and retries", async () => {
    db.status = { state: "blocked" };
    render(<StorageCard counts={counts} isFamily={false} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Close other LinkDish tabs/u);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(db.retry).toHaveBeenCalledTimes(1));
  });

  it("offers a reload when another tab updated LinkDish", async () => {
    db.status = { state: "outdated" };
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload }
    });

    try {
      render(<StorageCard counts={counts} isFamily={false} />);
      await screen.findByText("This browser doesn't say how much space LinkDish uses.");
      fireEvent.click(screen.getByRole("button", { name: "Reload to keep going" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("formats sizes for people", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(300)).toBe("1 KB");
    expect(formatBytes(512_000)).toBe("500 KB");
    expect(formatBytes(4_404_019)).toBe("4.2 MB");
    expect(formatBytes(157_286_400)).toBe("150 MB");
    expect(formatBytes(2_147_483_648)).toBe("2 GB");
  });
});
