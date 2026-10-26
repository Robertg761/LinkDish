import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fileMocks = vi.hoisted(() => ({
  pickFileAsync: vi.fn(),
  written: [] as Array<{ name: string; text: string }>
}));

const sharingMocks = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn()
}));

const savedRecipesState = vi.hoisted(() => ({
  collections: [] as unknown[],
  hasLoadedSavedRecipes: true,
  restoreBackup: vi.fn(),
  savedRecipes: [] as unknown[]
}));

const mealPlanState = vi.hoisted(() => ({
  entries: [] as unknown[],
  hasLoadedMealPlan: true,
  importEntries: vi.fn()
}));

vi.mock("expo-file-system", () => {
  class File {
    public static pickFileAsync = fileMocks.pickFileAsync;
    public readonly name: string;
    public readonly uri: string;

    public constructor(_directory: unknown, name: string) {
      this.name = name;
      this.uri = `file:///cache/${name}`;
    }

    public create() {
      return undefined;
    }

    public write(text: string) {
      fileMocks.written.push({ name: this.name, text });
    }
  }

  return { File, Paths: { cache: "cache" } };
});

vi.mock("expo-sharing", () => sharingMocks);

vi.mock("../../analytics/client", () => ({
  trackMobileEvent: vi.fn()
}));

vi.mock("@linkdish/ui", () => ({
  AppButton: ({
    disabled,
    label,
    onPress
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => React.createElement("AppButton", { disabled, label, onPress }, label),
  AppSurface: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppText", null, children),
  appColors: {},
  appSpacing: { md: 12, sm: 8 }
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("view", null, children)
}));

vi.mock("../saved-recipes/SavedRecipesContext", () => ({
  useSavedRecipes: () => savedRecipesState
}));

vi.mock("../meal-plan/MealPlanContext", () => ({
  useMealPlan: () => mealPlanState
}));

import { BackupCard } from "./BackupCard";

import type { RestorePlan } from "./backup";
import type { BackupRestoreCookbook } from "../saved-recipes/SavedRecipesContext";
import type { SavedRecipeRecord } from "../saved-recipes/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const soup: SavedRecipeRecord = {
  fetchMode: "http",
  id: "saved-soup",
  provenance: ["jsonld"],
  recipe: { ...SAMPLE_RECIPES[0].recipe, sourceUrl: "https://example.com/soup", title: "Soup" },
  savedAt: "2026-10-01T12:00:00.000Z",
  strategy: "recipe-schema",
  timesCooked: 2,
  warnings: []
};

const render = async () => {
  let renderer: ReactTestRenderer | undefined;

  await act(async () => {
    renderer = create(<BackupCard />);
    await Promise.resolve();
  });

  return renderer!;
};

const pressButton = async (renderer: ReactTestRenderer, label: string) => {
  await act(async () => {
    (renderer.root.findByProps({ label }).props as { onPress: () => void }).onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const textOf = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => (node.type as unknown) === "AppText")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""))
    .join("\n");

describe("BackupCard", () => {
  beforeEach(() => {
    fileMocks.pickFileAsync.mockReset();
    fileMocks.written = [];
    sharingMocks.isAvailableAsync.mockReset().mockResolvedValue(true);
    sharingMocks.shareAsync.mockReset().mockResolvedValue(undefined);
    savedRecipesState.savedRecipes = [soup];
    savedRecipesState.restoreBackup.mockReset();
    mealPlanState.importEntries.mockReset().mockResolvedValue(0);
  });

  it("saves a backup file and opens the share sheet with it", async () => {
    const renderer = await render();

    await pressButton(renderer, "Back up");

    expect(fileMocks.written).toHaveLength(1);
    expect(fileMocks.written[0]?.name).toMatch(/^linkdish-backup-\d{4}-\d{2}-\d{2}\.json$/u);
    expect(JSON.parse(fileMocks.written[0]?.text ?? "{}")).toMatchObject({
      format: "linkdish-backup",
      recipes: [{ id: "saved-soup", meta: { timesCooked: 2 } }]
    });
    expect(sharingMocks.shareAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/cache\/linkdish-backup-/u),
      expect.objectContaining({ mimeType: "application/json" })
    );
  });

  it("restores a picked backup and says what it added", async () => {
    const renderer = await render();
    await pressButton(renderer, "Back up");
    const text = fileMocks.written[0]!.text;

    fileMocks.pickFileAsync.mockResolvedValue({
      canceled: false,
      result: { size: text.length, text: () => Promise.resolve(text) }
    });
    savedRecipesState.restoreBackup.mockImplementation(
      (plan: (cookbook: BackupRestoreCookbook) => RestorePlan) =>
        Promise.resolve(plan({ collections: [], freeSlots: Number.POSITIVE_INFINITY, records: [] }))
    );

    await pressButton(renderer, "Restore");

    expect(savedRecipesState.restoreBackup).toHaveBeenCalledTimes(1);
    expect(mealPlanState.importEntries).toHaveBeenCalledWith([]);
    expect(textOf(renderer)).toContain("Restored 1 recipe.");
  });

  it("explains a file that isn't a backup and changes nothing", async () => {
    fileMocks.pickFileAsync.mockResolvedValue({
      canceled: false,
      result: { size: 12, text: () => Promise.resolve('{"hello":1}') }
    });
    const renderer = await render();

    await pressButton(renderer, "Restore");

    expect(savedRecipesState.restoreBackup).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain("This is not a LinkDish backup.");
  });

  it("does nothing when the picker is closed", async () => {
    fileMocks.pickFileAsync.mockResolvedValue({ canceled: true, result: null });
    const renderer = await render();

    await pressButton(renderer, "Restore");

    expect(savedRecipesState.restoreBackup).not.toHaveBeenCalled();
    expect(textOf(renderer)).not.toContain("backup.");
  });
});
