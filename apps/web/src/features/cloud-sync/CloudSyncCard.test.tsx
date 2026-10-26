import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudSyncCard } from "./CloudSyncCard";
import { resetLibrarySyncStatusForTests, setLibrarySyncStatus } from "./library-sync-status";

const syncMocks = vi.hoisted(() => ({
  countChangesNotSynced: vi.fn(),
  switchToSignedInCookbook: vi.fn(),
  syncLibraryNow: vi.fn()
}));

vi.mock("./library-sync", () => syncMocks);

afterEach(() => {
  resetLibrarySyncStatusForTests();
  vi.clearAllMocks();
});

describe("CloudSyncCard", () => {
  it("shows nothing while cloud sync is off", () => {
    const { container } = render(<CloudSyncCard />);

    expect(container).toBeEmptyDOMElement();
  });

  it("says when the cookbook last synced, and syncs again on request", async () => {
    syncMocks.syncLibraryNow.mockResolvedValue(undefined);
    render(<CloudSyncCard />);

    act(() => {
      setLibrarySyncStatus({ account: "u1", held: 2, lastSyncedAt: Date.now(), phase: "synced" });
    });

    expect(screen.getByRole("region", { name: "Cookbook sync" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Synced just now.");
    expect(screen.getByText(/2 recipes or collections couldn.t sync/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(syncMocks.syncLibraryNow).toHaveBeenCalledTimes(1));
  });

  it("warns about unsynced changes before replacing another account's cookbook", async () => {
    syncMocks.countChangesNotSynced.mockResolvedValue(3);
    syncMocks.switchToSignedInCookbook.mockResolvedValue(undefined);
    render(<CloudSyncCard />);

    act(() => {
      setLibrarySyncStatus({ account: "u2", phase: "other_account" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Use my cookbook here" }));
    expect(
      await screen.findByText(/3 changes made here haven.t synced to the other account/u)
    ).toBeInTheDocument();
    expect(syncMocks.switchToSignedInCookbook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Replace with my cookbook" }));
    await waitFor(() => expect(syncMocks.switchToSignedInCookbook).toHaveBeenCalledTimes(1));
  });
});
