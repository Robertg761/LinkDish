import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCollectionsStoreForTests } from "../../data/collections-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import {
  getPreferences,
  PREFERENCES_STORAGE_KEY,
  resetPreferencesForTests
} from "../../preferences/preferences-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import {
  buildPaprikaExport,
  fileFromBytes,
  jsonBytes,
  paprikaRecipe
} from "../data-transfer/testing/zip-fixtures";
import { getSavedRecipes, LOCAL_LIMIT_FREE, putSavedRecipe } from "../library/saved-recipe-store";

import { SettingsPage } from "./SettingsPage";

import type { WebSavedRecipe } from "../library/saved-recipe-types";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
vi.mock("../../api/client", () => ({ apiClient: {} }));

const mocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn(),
  requestUpgradeSheet: vi.fn(() => true),
  user: null as null | { id: string; email: string; billingPlan: "free" | "plus" | "family" }
}));

vi.mock("../../analytics/client", () => ({ trackWebEvent: mocks.trackWebEvent }));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, isAuthenticated: Boolean(mocks.user) })
}));
vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: mocks.requestUpgradeSheet })
}));

const saved = (id: string, overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  id,
  recipe: {
    title: `Recipe ${id}`,
    sourceUrl: `https://example.com/${id}`,
    sourceType: "recipe-webpage",
    ingredients: [{ text: "1 cup rice" }],
    steps: [{ index: 1, text: "Cook it." }],
    servings: "2",
    prepTimeMinutes: null,
    cookTimeMinutes: null,
    nutrition: null,
    confidence: {
      score: 0.9,
      summary: "ok",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "jsonld",
        ingredients: "jsonld",
        steps: "jsonld",
        servings: null,
        prepTimeMinutes: null,
        cookTimeMinutes: null,
        nutrition: null
      }
    }
  },
  sourceUrl: `https://example.com/${id}`,
  sourceHost: "example.com",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  timesCooked: 0,
  sync: { status: "local_only" },
  ...overrides
});

const soups = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    paprikaRecipe({
      uid: `soup-${index}`,
      name: `Soup number ${index + 1}`,
      source_url: `https://soups.example.com/soup-${index + 1}`
    })
  );

/** Renders the page and waits until the data cards finished their first reads. */
const renderPage = async (path = "/settings") => {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<SettingsPage />} path="/settings" />
        <Route element={<p>Pricing page</p>} path="/pricing" />
        <Route element={<p>Cookbook page</p>} path="/" />
      </Routes>
    </MemoryRouter>
  );
  const storage = screen.getByTestId("storage-card");
  const backup = screen.getByTestId("backup-card");

  await waitFor(() => {
    expect(storage).not.toHaveTextContent(/Checking how much space/u);
    expect(within(storage).queryByText("–")).not.toBeInTheDocument();
    expect(backup).not.toHaveTextContent(/Gathering your recipes/u);
  });

  return view;
};

const chooseFile = (file: File) => {
  fireEvent.change(screen.getByTestId("import-file-input"), { target: { files: [file] } });
};

// The import flows read files, unzip and write IndexedDB; give them room on a busy CI machine.
describe("SettingsPage", { timeout: 20_000 }, () => {
  beforeAll(async () => {
    configure({ asyncUtilTimeout: 5_000 });
    // Warm the lazily loaded import/export code so the first test does not pay for it.
    await Promise.all([import("../data-transfer/data-transfer"), import("./ImportSheet")]);
  });

  beforeEach(() => {
    window.localStorage.clear();
    // Skip first-run starter seeding unless a test wants starters.
    window.localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
    resetPreferencesForTests();
    document.documentElement.removeAttribute("data-theme");
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    resetLibraryStoreForTests();
    resetCollectionsStoreForTests();
    mocks.trackWebEvent.mockReset();
    mocks.requestUpgradeSheet.mockReset();
    mocks.requestUpgradeSheet.mockReturnValue(true);
    mocks.user = null;
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches the theme and applies it to the document", async () => {
    await renderPage();

    const dark = screen.getByRole("radio", { name: "Dark" });
    fireEvent.click(dark);

    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}")).toMatchObject({
      theme: "dark"
    });
  });

  it("saves units, cooking and week preferences", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("radio", { name: "Metric" }));
    fireEvent.click(screen.getByRole("switch", { name: "Keep screen awake" }));
    fireEvent.click(screen.getByRole("radio", { name: "Largest" }));
    fireEvent.click(screen.getByRole("radio", { name: "Monday" }));

    expect(getPreferences()).toMatchObject({
      units: "metric",
      keepScreenAwake: false,
      cookTextSize: "xl",
      weekStartsOn: 1
    });
    expect(screen.getByText(/grams, millilitres/)).toBeInTheDocument();
  });

  it("links to install, support and privacy and shows the data tools", async () => {
    await renderPage();

    expect(screen.getByRole("link", { name: /install linkdish/i })).toHaveAttribute(
      "href",
      "/install"
    );
    expect(screen.getByRole("link", { name: /help & support/i })).toHaveAttribute(
      "href",
      "/support"
    );
    expect(screen.getByRole("link", { name: /privacy/i })).toHaveAttribute("href", "/privacy");

    const data = screen.getByRole("region", { name: "Your data" });
    expect(
      within(data).getByRole("heading", { name: "Back up your cookbook" })
    ).toBeInTheDocument();
    expect(within(data).getByRole("heading", { name: "Import recipes" })).toBeInTheDocument();
    expect(
      within(data).getByRole("heading", { name: "Storage on this device" })
    ).toBeInTheDocument();
    // Nothing to back up yet.
    expect(await within(data).findByText(/Save a recipe first/u)).toBeInTheDocument();
    expect(within(data).getByRole("button", { name: "Download a backup" })).toBeDisabled();
  });

  it("downloads a backup and remembers when", async () => {
    await putSavedRecipe(saved("mine", { favorite: true }));
    URL.createObjectURL = vi.fn(() => "blob:backup");
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    await renderPage();

    const download = await screen.findByRole("button", { name: "Download a backup" });
    await waitFor(() => expect(download).toBeEnabled());
    expect(screen.getByText(/One file with your 1 recipe/u)).toBeInTheDocument();
    fireEvent.click(download);

    await screen.findByText(/Last backup from this browser: today/u);
    expect(click).toHaveBeenCalledTimes(1);
    expect(mocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "library_exported",
        properties: { recipe_count: 1, include_images: false, format: "backup" }
      })
    );
  });

  it("offers to include scanned photos with their size", async () => {
    await putSavedRecipe(
      saved("scan", {
        sourceImages: [
          { dataUrl: `data:image/jpeg;base64,${"A".repeat(4096)}`, mimeType: "image/jpeg" }
        ]
      })
    );
    await renderPage();

    const toggle = await screen.findByRole("switch", { name: "Include scanned photos" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await screen.findByText("Adds about 4 KB for 1 photo import.")).toBeInTheDocument();
  });

  it("previews and imports a Paprika export, keeping both copies of duplicates", async () => {
    await renderPage();
    chooseFile(
      fileFromBytes(
        await buildPaprikaExport([paprikaRecipe(), ...soups(2)]),
        "My Recipes.paprikarecipes"
      )
    );
    const sheet = await screen.findByRole("dialog", { name: "Import recipes" });
    await within(sheet).findByText("recipes found");
    expect(within(sheet).getByText("From Paprika")).toBeInTheDocument();
    expect(within(sheet).getByText("3")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Import 3 recipes" }));
    await within(sheet).findByText("3 recipes added to your cookbook");
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));

    // The same file again: everything is already here.
    chooseFile(
      fileFromBytes(
        await buildPaprikaExport([paprikaRecipe(), ...soups(2)]),
        "My Recipes.paprikarecipes"
      )
    );
    const again = await screen.findByRole("dialog", { name: "Import recipes" });
    await within(again).findByText(/3 are already in your cookbook/u);
    expect(within(again).getByRole("button", { name: "Nothing new to import" })).toBeDisabled();

    fireEvent.click(within(again).getByRole("radio", { name: "Keep both" }));
    fireEvent.click(await within(again).findByRole("button", { name: "Import 3 recipes" }));
    await within(again).findByText("3 recipes added to your cookbook");
    expect(within(again).getByText("3 second copies added")).toBeInTheDocument();
    expect(await getSavedRecipes()).toHaveLength(6);
    expect(mocks.trackWebEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventName: "library_imported",
        properties: expect.objectContaining({ source: "paprika", recipe_count: 3 }) as Record<
          string,
          unknown
        >
      })
    );
  });

  it("imports only what fits in a free cookbook, then offers unlimited recipes", async () => {
    for (let index = 0; index < LOCAL_LIMIT_FREE - 1; index += 1) {
      await putSavedRecipe(saved(`mine-${index}`));
    }
    mocks.requestUpgradeSheet.mockReturnValue(false);
    await renderPage();
    chooseFile(fileFromBytes(await buildPaprikaExport(soups(3)), "export.paprikarecipes"));

    const sheet = await screen.findByRole("dialog", { name: "Import recipes" });
    expect(
      await within(sheet).findByText("Room for 1 more recipe on the free plan")
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Import 1 recipe" }));

    await within(sheet).findByText("1 recipe added to your cookbook");
    expect(within(sheet).getByText(/2 recipes didn't fit in your free/u)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Get unlimited recipes" }));

    expect(mocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit");
    // The upgrade sheet was already shown this session, so the plans page opens instead.
    expect(await screen.findByText("Pricing page")).toBeInTheDocument();
    expect(await getSavedRecipes()).toHaveLength(LOCAL_LIMIT_FREE);
  });

  it("imports everything for Plus cooks", async () => {
    mocks.user = { id: "u1", email: "cook@example.com", billingPlan: "plus" };
    for (let index = 0; index < LOCAL_LIMIT_FREE; index += 1) {
      await putSavedRecipe(saved(`mine-${index}`));
    }
    await renderPage();
    chooseFile(fileFromBytes(await buildPaprikaExport(soups(2)), "export.paprikarecipes"));

    const sheet = await screen.findByRole("dialog", { name: "Import recipes" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Import 2 recipes" }));
    await within(sheet).findByText("2 recipes added to your cookbook");
    expect(await getSavedRecipes()).toHaveLength(LOCAL_LIMIT_FREE + 2);
  });

  it("explains files it can't read without raw errors", async () => {
    await renderPage();
    chooseFile(fileFromBytes(jsonBytes({ hello: "world" }), "notes.json"));

    const sheet = await screen.findByRole("dialog", { name: "We couldn't import that" });
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      /LinkDish can't read that kind of file yet/u
    );
    const picker = vi.spyOn(screen.getByTestId("import-file-input"), "click");
    fireEvent.click(within(sheet).getByRole("button", { name: "Choose another file" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(picker).toHaveBeenCalled();
  });

  it("restores a backup made by Export, collections and all", async () => {
    await putSavedRecipe(saved("mine", { favorite: true, notes: "Lots of garlic." }));
    let exported: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      exported = blob;
      return "blob:backup";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await renderPage();
    const download = await screen.findByRole("button", { name: "Download a backup" });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    await screen.findByText(/Last backup from this browser/u);
    expect(exported).not.toBeNull();

    // Wipe the cookbook, then restore the file.
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    chooseFile(new File([exported!], "linkdish-backup-2026-09-28.json"));

    const sheet = await screen.findByRole("dialog", { name: "Restore a backup" });
    expect(await within(sheet).findByText(/^Backup from /u)).toBeInTheDocument();
    // The plan (and so the button's label) follows the header by a render.
    fireEvent.click(await within(sheet).findByRole("button", { name: "Restore 1 recipe" }));
    await within(sheet).findByText("1 recipe restored");
    expect((await getSavedRecipes())[0]).toMatchObject({
      id: "mine",
      favorite: true,
      notes: "Lots of garlic."
    });
  });

  it("jumps to a section from the URL hash", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderPage("/settings#your-data");

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute("id", "settings-your-data");
    expect(screen.getByRole("heading", { name: "Your data" })).toHaveFocus();
  });
});
