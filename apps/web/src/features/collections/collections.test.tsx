import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCollectionsStoreForTests } from "../../data/collections-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { CollectionPickerSheet } from "./CollectionPickerSheet";
import { ManageCollectionsSheet } from "./ManageCollectionsSheet";
import { TagEditorSheet } from "./TagEditorSheet";

import type { WebCollection } from "../../data/collections-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
vi.mock("../../api/client", () => ({ apiBaseUrl: "/api", apiClient: {} }));

const makeRecipe = (
  id: string,
  title: string,
  extra: Partial<WebSavedRecipe> = {},
  ingredients: string[] = ["1 onion"]
): WebSavedRecipe =>
  ({
    createdAt: "2026-09-01T00:00:00.000Z",
    extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
    id,
    recipe: {
      cookTimeMinutes: 10,
      image: null,
      ingredients: ingredients.map((text) => ({ text })),
      nutrition: null,
      prepTimeMinutes: 5,
      servings: "2",
      sourceType: "recipe-webpage",
      sourceUrl: `https://example.com/${id}`,
      steps: [{ index: 1, text: "Toss everything together." }],
      title
    },
    sourceHost: "example.com",
    sourceUrl: `https://example.com/${id}`,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...extra
  }) as WebSavedRecipe;

const collection = (
  id: string,
  name: string,
  sortOrder: number,
  emoji?: string
): WebCollection => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  id,
  name,
  sortOrder,
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...(emoji ? { emoji } : {})
});

const stored = (id: string) => fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id);

const renderWithToasts = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);

describe("collections sheets", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    localStorage.clear();
    localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    resetCollectionsStoreForTests();
    setDataChannelFactoryForTests(() => ({
      close: vi.fn(),
      onmessage: null,
      postMessage: vi.fn()
    }));
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    await getLinkDishWebDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toggles membership for several recipes at once, showing a mixed state", async () => {
    fakeIdb.seed(COLLECTIONS_STORE_NAME, [collection("dinners", "Dinners", 0, "🍲")]);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      makeRecipe("a", "Alpha", { collectionIds: ["dinners"] }),
      makeRecipe("b", "Bravo")
    ]);

    renderWithToasts(<CollectionPickerSheet onClose={vi.fn()} open recipeIds={["a", "b"]} />);

    const option = await screen.findByRole("checkbox", { name: /Dinners/ });
    expect(screen.getByText("Choose collections for 2 recipes.")).toBeInTheDocument();
    expect(option).toHaveAttribute("aria-checked", "mixed");
    expect(option).toHaveTextContent("1 recipe");

    fireEvent.click(option);
    await waitFor(() => expect(stored("b")?.collectionIds).toEqual(["dinners"]));
    expect(stored("a")?.collectionIds).toEqual(["dinners"]);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /Dinners/ })).toHaveAttribute(
        "aria-checked",
        "true"
      )
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Dinners/ }));
    await waitFor(() => expect(stored("a")?.collectionIds).toBeUndefined());
    expect(stored("b")?.collectionIds).toBeUndefined();
  });

  it("opens straight into the create form when there are no collections, and validates it", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [makeRecipe("a", "Alpha")]);
    const onClose = vi.fn();

    renderWithToasts(<CollectionPickerSheet onClose={onClose} open recipeIds={["a"]} />);

    const form = await screen.findByRole("form", { name: "New collection" });
    fireEvent.click(within(form).getByRole("button", { name: "Create and add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Give the collection a name.");

    fireEvent.change(within(form).getByRole("textbox", { name: "Collection name" }), {
      target: { value: "  Holiday   baking " }
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create and add" }));

    await waitFor(() =>
      expect(fakeIdb.records<WebCollection>(COLLECTIONS_STORE_NAME)[0]?.name).toBe("Holiday baking")
    );
    await waitFor(() => expect(stored("a")?.collectionIds).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("changes a collection's emoji and adds new collections from the manager", async () => {
    fakeIdb.seed(COLLECTIONS_STORE_NAME, [collection("dinners", "Dinners", 0)]);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [makeRecipe("a", "Alpha")]);

    renderWithToasts(<ManageCollectionsSheet onClose={vi.fn()} open />);

    fireEvent.click(await screen.findByRole("button", { name: "Change emoji for Dinners" }));
    fireEvent.click(screen.getByRole("radio", { name: "🌮" }));
    await waitFor(() =>
      expect(fakeIdb.record<WebCollection>(COLLECTIONS_STORE_NAME, "dinners")?.emoji).toBe("🌮")
    );

    fireEvent.click(screen.getByRole("button", { name: "New collection" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Collection name" }), {
      target: { value: "Brunch" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("textbox", { name: "Name of Brunch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Brunch down" })).toBeDisabled();
  });

  it("suggests tags from the recipe and the cookbook, preferring the cook's spelling", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      makeRecipe("salad", "Greek Salad", {}, [
        "1 cucumber",
        "2 tomatoes",
        "4 oz feta",
        "Kalamata olives",
        "Dried oregano"
      ]),
      makeRecipe("other", "Other", { tags: ["Weeknight", "salad"] })
    ]);

    renderWithToasts(<TagEditorSheet onClose={vi.fn()} open recipeId="salad" />);

    const suggestions = await screen.findByRole("list", { name: "Suggested tags" });
    const labels = within(suggestions)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toContain("Weeknight");
    expect(labels).toContain("Quick");
    // "salad" was inferred and already used by the cook: their spelling wins, once.
    expect(labels.filter((label) => label?.toLowerCase() === "salad")).toEqual(["salad"]);

    fireEvent.click(within(suggestions).getByRole("button", { name: "Add tag Quick" }));
    await waitFor(() => expect(stored("salad")?.tags).toEqual(["Quick"]));
  });

  it("adds typed tags, removes the last one with Backspace and saves a draft on Done", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [makeRecipe("soup", "Soup", { tags: ["Winter"] })]);
    const onClose = vi.fn();

    renderWithToasts(<TagEditorSheet onClose={onClose} open recipeId="soup" />);

    const input = await screen.findByRole("textbox", { name: "Add a tag" });
    fireEvent.change(input, { target: { value: "Cozy," } });
    await waitFor(() => expect(stored("soup")?.tags).toEqual(["Winter", "Cozy"]));

    fireEvent.keyDown(input, { key: "Backspace" });
    await waitFor(() => expect(stored("soup")?.tags).toEqual(["Winter"]));

    fireEvent.change(input, { target: { value: "Freezer friendly" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(stored("soup")?.tags).toEqual(["Winter", "Freezer friendly"]));
    expect(onClose).toHaveBeenCalled();
  });
});
