import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetImportQueueStoreForTests } from "../../data/import-queue-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import {
  getLinkDishWebDb,
  IMPORT_QUEUE_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { ImportQueuePanel } from "./ImportQueuePanel";

import type { ImportQueueRunnerState } from "./use-import-queue-runner";
import type { ImportQueueItem } from "../../data/import-queue-store";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
vi.mock("../../api/client", () => ({ apiClient: {} }));

const upgradeMocks = vi.hoisted(() => ({ requestUpgradeSheet: vi.fn(() => true) }));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const item = (id: string, overrides: Partial<ImportQueueItem>): ImportQueueItem => ({
  attempts: 0,
  createdAt: "2026-09-28T10:00:00.000Z",
  id,
  status: "queued",
  updatedAt: "2026-09-28T10:00:00.000Z",
  ...overrides
});

const runner = (overrides: Partial<ImportQueueRunnerState> = {}): ImportQueueRunnerState => ({
  online: true,
  paused: null,
  resume: vi.fn(),
  running: false,
  stalled: false,
  ...overrides
});

const renderPanel = (state: ImportQueueRunnerState, onOpenItem = vi.fn()) =>
  render(
    <ToastProvider>
      <MemoryRouter>
        <ImportQueuePanel onOpenItem={onOpenItem} runner={state} />
      </MemoryRouter>
    </ToastProvider>
  );

describe("ImportQueuePanel", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    localStorage.clear();
    localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    resetImportQueueStoreForTests();
    resetLibraryStoreForTests();
    upgradeMocks.requestUpgradeSheet.mockClear();
    await getLinkDishWebDb();
  });

  it("pauses quietly on a full cookbook and opens the upgrade sheet only when tapped", async () => {
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [
      item("a", { url: "https://www.bonappetit.com/recipe/rice" }),
      item("b", { url: "https://cooking.nytimes.com/recipes/soup" })
    ]);

    renderPanel(runner({ paused: "save_limit" }));

    const note = (await screen.findByText(/Cookbook full · 2 links waiting\./u)).closest(
      ".import-queue-note"
    ) as HTMLElement;
    expect(note).toHaveAttribute("role", "status");
    expect(upgradeMocks.requestUpgradeSheet).not.toHaveBeenCalled();

    fireEvent.click(within(note).getByRole("button", { name: "Get Plus" }));
    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit");
  });

  it("says when storage trouble stopped the queue, and tries again when tapped", async () => {
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [
      item("a", { url: "https://www.bonappetit.com/recipe/rice" })
    ]);
    const state = runner({ stalled: true });

    renderPanel(state);

    const note = (await screen.findByText(/Stopped for now · 1 link waiting\./u)).closest(
      ".import-queue-note"
    ) as HTMLElement;
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent("We’ll try again shortly.");

    fireEvent.click(within(note).getByRole("button", { name: "Try again" }));
    expect(state.resume).toHaveBeenCalledOnce();
  });

  it("gives every row one anatomy: title, trailing actions, a full-width status", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      {
        createdAt: "2026-09-28T10:00:00.000Z",
        id: "saved-bread",
        recipe: {
          image: null,
          ingredients: [{ text: "flour" }],
          sourceUrl: "https://www.seriouseats.com/bread",
          steps: [{ index: 1, text: "Bake." }],
          title: "Classic Sandwich Bread"
        },
        sourceHost: "seriouseats.com",
        sourceUrl: "https://www.seriouseats.com/bread",
        updatedAt: "2026-09-28T10:00:00.000Z"
      }
    ]);
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [
      item("done", {
        recipeId: "saved-bread",
        status: "done",
        url: "https://www.seriouseats.com/bread"
      }),
      item("failed", {
        error: "This one needs AI help. Open it to try.",
        status: "failed",
        url: "https://www.tiktok.com/@cook/video/1"
      }),
      item("waiting", { url: "https://www.bonappetit.com/recipe/rice" })
    ]);
    const onOpenItem = vi.fn();

    renderPanel(runner(), onOpenItem);

    // Done: the saved title opens the recipe; no separate "Open" crowding it.
    const title = await screen.findByRole("link", { name: "Classic Sandwich Bread" });
    expect(title).toHaveAttribute("href", "/recipes/saved-bread");

    const rows = screen.getAllByRole("listitem");
    const failed = rows[1];
    expect(failed).toHaveTextContent("This one needs AI help. Open it to try.");
    fireEvent.click(within(failed as HTMLElement).getByRole("button", { name: "Open" }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "failed" }));

    // Pending: the site is shown quietly until there's a title.
    expect(rows[2]?.querySelector(".import-queue-item-title.is-source")).toHaveTextContent(
      "bonappetit.com"
    );
  });

  it("keeps a waiting link that another tab started importing when Remove is tapped", async () => {
    const waiting = item("waiting", { url: "https://www.bonappetit.com/recipe/rice" });
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [waiting]);
    renderPanel(runner());
    const remove = await screen.findByRole("button", { name: "Remove bonappetit.com" });

    // Another tab's worker claims it before this tab hears about it.
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [
      { ...waiting, claimedAt: new Date().toISOString(), claimedBy: "tab-b", status: "processing" }
    ]);
    fireEvent.click(remove);

    expect(await screen.findByText("That one’s importing already.")).toBeVisible();
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, "waiting")).toMatchObject({
      claimedBy: "tab-b",
      status: "processing"
    });
  });
});
