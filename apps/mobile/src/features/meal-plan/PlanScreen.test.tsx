import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const shoppingMocks = vi.hoisted(() => ({
  addItems: vi.fn(),
  shoppingItems: [] as unknown[]
}));

const savedRecipesState = vi.hoisted(() => ({
  getSavedRecipeById: vi.fn(),
  savedRecipes: [] as unknown[]
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("../../analytics/client", () => ({
  trackMobileEvent: vi.fn()
}));

vi.mock("../../lib/haptics", () => ({
  selectionTick: vi.fn(),
  success: vi.fn(),
  warn: vi.fn()
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
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
  appSpacing: { lg: 16, md: 12, sm: 8, xl: 20, xs: 4 }
}));

vi.mock("expo-router", () => ({
  router: { push: vi.fn() },
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => ({})
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("safe-area", null, children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: () => ({ remove: () => undefined })
  },
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("pressable", props, children),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("scroll-view", null, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  TextInput: (props: Record<string, unknown>) => React.createElement("TextInput", props),
  View: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("view", props, children)
}));

vi.mock("../../components/AppSheet", () => ({
  AppSheet: ({
    children,
    footer,
    testID,
    title,
    visible
  }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
    testID?: string;
    title: string;
    visible: boolean;
  }) => (visible ? React.createElement("app-sheet", { testID, title }, children, footer) : null)
}));

vi.mock("../saved-recipes/SavedRecipesContext", () => ({
  useSavedRecipes: () => savedRecipesState
}));

vi.mock("../shopping/ShoppingListContext", () => ({
  useShoppingList: () => shoppingMocks
}));

import { MealPlanProvider, useMealPlan } from "./MealPlanContext";
import { PlanScreen } from "./PlanScreen";

import type { SavedRecipeRecord } from "../saved-recipes/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const soup: SavedRecipeRecord = {
  fetchMode: "http",
  id: "saved-soup",
  provenance: ["jsonld"],
  recipe: {
    ...SAMPLE_RECIPES[0].recipe,
    ingredients: [{ text: "2 onions" }, { text: "1 tsp salt" }],
    servings: "4",
    title: "Onion soup"
  },
  savedAt: "2026-10-01T12:00:00.000Z",
  strategy: "recipe-schema",
  warnings: []
};

let plan: ReturnType<typeof useMealPlan> | null = null;

const Probe = () => {
  plan = useMealPlan();
  return null;
};

const render = async () => {
  let renderer: ReturnType<typeof create> | undefined;

  await act(async () => {
    renderer = create(
      <MealPlanProvider>
        <Probe />
        <PlanScreen />
      </MealPlanProvider>
    );
    await Promise.resolve();
  });

  return renderer!;
};

const press = (node: ReactTestInstance) => {
  act(() => {
    (node.props as { onPress: () => void }).onPress();
  });
};

const textOf = (renderer: ReturnType<typeof create>) =>
  renderer.root
    .findAll((node) => (node.type as unknown) === "AppText")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""))
    .join("\n");

describe("PlanScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 26, 12));
    plan = null;
    asyncStorageMocks.getItem.mockReset().mockResolvedValue(null);
    asyncStorageMocks.setItem.mockReset().mockResolvedValue(undefined);
    shoppingMocks.addItems.mockReset();
    savedRecipesState.savedRecipes = [soup];
    savedRecipesState.getSavedRecipeById.mockImplementation((id: string) =>
      id === soup.id ? soup : undefined
    );
  });

  it("shows this week and plans a recipe on a day", async () => {
    const renderer = await render();

    expect(textOf(renderer)).toContain("This week");
    expect(textOf(renderer)).toContain("Oct 25 – Oct 31");
    expect(textOf(renderer)).toContain("Today · Oct 26");

    press(renderer.root.findByProps({ testID: "plan-add-2026-10-27" }));
    expect(renderer.root.findByProps({ testID: "plan-meal-sheet" })).toBeTruthy();

    press(renderer.root.findByProps({ accessibilityLabel: "Onion soup" }));

    expect(plan?.entries).toEqual([
      expect.objectContaining({
        date: "2026-10-27",
        recipeId: "saved-soup",
        servings: 4,
        slot: "dinner",
        title: "Onion soup"
      })
    ]);
    expect(renderer.root.findAllByProps({ testID: "plan-meal-sheet" })).toHaveLength(0);
    expect(textOf(renderer)).toContain("Dinner · 4 servings");
  });

  it("keeps this week in view when a Monday start loads after the screen", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === "linkdish.mealPlan.weekStartsOn.v1" ? "1" : null)
    );
    const renderer = await render();

    expect(plan?.weekStartsOn).toBe(1);
    expect(textOf(renderer)).toContain("This week");
    expect(textOf(renderer)).toContain("Oct 26 – Nov 1");
  });

  it("plans a quick note and moves to next week", async () => {
    const renderer = await render();

    press(renderer.root.findByProps({ testID: "plan-add-2026-10-26" }));
    press(renderer.root.findByProps({ accessibilityLabel: "Leftovers" }));

    expect(plan?.entries[0]).toMatchObject({ date: "2026-10-26", title: "Leftovers" });
    expect(plan?.entries[0]).not.toHaveProperty("recipeId");

    press(renderer.root.findByProps({ accessibilityLabel: "Next week" }));
    expect(textOf(renderer)).toContain("Next week");
    expect(textOf(renderer)).not.toContain("Leftovers");
  });

  it("turns the week's recipes into shopping, leaving pantry staples unticked", async () => {
    const renderer = await render();

    act(() => {
      plan?.addEntry(
        { date: "2026-10-28", recipeId: soup.id, servings: 8, slot: "dinner", title: "Onion soup" },
        "plan"
      );
      plan?.addEntry({ date: "2026-10-29", slot: "dinner", title: "Takeout" }, "plan");
    });

    press(renderer.root.findByProps({ label: "Shop for the week" }));
    expect(textOf(renderer)).toContain(
      "1 meal has no recipe (like leftovers), so it adds nothing."
    );

    press(renderer.root.findByProps({ label: "Add 1 item" }));

    expect(shoppingMocks.addItems).toHaveBeenCalledWith([
      { recipeId: "saved-soup", recipeTitle: "Onion soup", text: "4 onions" }
    ]);
    expect(textOf(renderer)).toContain("Added 1 item to your shopping list.");
  });

  it("opens a planned meal to rescale or remove it", async () => {
    const renderer = await render();

    act(() => {
      plan?.addEntry(
        { date: "2026-10-26", recipeId: soup.id, servings: 4, slot: "dinner", title: "Onion soup" },
        "plan"
      );
    });

    press(renderer.root.findByProps({ accessibilityLabel: "Dinner: Onion soup" }));
    press(renderer.root.findByProps({ accessibilityLabel: "More servings" }));
    expect(plan?.entries[0]?.servings).toBe(5);

    press(renderer.root.findByProps({ label: "Remove from plan" }));
    expect(plan?.entries).toEqual([]);
    expect(renderer.root.findAllByProps({ testID: "plan-entry-sheet" })).toHaveLength(0);
  });
});
