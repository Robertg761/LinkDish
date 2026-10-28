import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shoppingState = vi.hoisted(() => ({
  addItems: vi.fn(),
  canSyncShoppingList: false,
  clearCheckedItems: vi.fn(),
  deleteItem: vi.fn(),
  hasLoadedShoppingItems: true,
  isRefreshingShoppingList: false,
  refreshShoppingList: vi.fn(),
  setItemChecked: vi.fn(),
  shoppingError: null as string | null,
  shoppingItems: [] as unknown[]
}));

const recipeState = vi.hoisted(() => ({ savedRecipes: [] as unknown[] }));

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
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
  AppSurface: ({ children }: { children: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppText", null, children)
}));

vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => callback()
}));

vi.mock("react-native", () => ({
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("Pressable", props, children),
  RefreshControl: (props: Record<string, unknown>) => React.createElement("RefreshControl", props),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("ScrollView", null, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  TextInput: (props: Record<string, unknown>) => React.createElement("TextInput", props),
  View: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("View", props, children)
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement("animated-view", props, children)
  },
  cancelAnimation: vi.fn(),
  Easing: {
    cubic: vi.fn((value: number) => value),
    inOut: vi.fn((easing: unknown) => easing),
    linear: vi.fn((value: number) => value)
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  ReduceMotion: {
    System: "system"
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: number) => React.useRef({ value: initial }).current,
  withRepeat: (value: number) => value,
  withTiming: (value: number) => value
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("SafeAreaView", null, children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}));

vi.mock("../../components/AppDialog", () => ({
  AppDialog: (props: {
    actions: Array<{ label: string; onPress: () => void }>;
    message: string;
    title: string;
    visible: boolean;
  }) => React.createElement("AppDialog", props)
}));

vi.mock("../saved-recipes/SavedRecipesContext", () => ({
  useSavedRecipes: () => recipeState
}));

vi.mock("./ShoppingListContext", () => ({
  useShoppingList: () => shoppingState
}));

vi.mock("../../lib/haptics", () => ({
  selectionTick: vi.fn()
}));

vi.mock("../../theme/tokens", () => ({
  appColors: {
    accent: "#29443b",
    accentSoft: "#dde7df",
    background: "#f4efe7",
    border: "#ddd2c3",
    canvas: "#fbf7f0",
    dangerText: "#8b2e23",
    muted: "#6e685f",
    placeholder: "rgba(110, 104, 95, 0.6)",
    surface: "#fffdf8",
    text: "#1f211d"
  },
  appSpacing: {
    lg: 16,
    md: 12,
    sm: 8,
    xl: 20,
    xs: 4
  }
}));

import ShoppingScreen from "../../../app/(tabs)/shopping";

import type { MobileShoppingItem } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = "2026-07-04T12:00:00.000Z";

const buildItem = (overrides: Partial<MobileShoppingItem>): MobileShoppingItem => ({
  addedBy: "local",
  checked: false,
  checkedBy: null,
  createdAt: now,
  id: "item",
  sync: { status: "local_only" },
  text: "milk",
  updatedAt: now,
  ...overrides
});

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

type DialogProps = {
  actions: Array<{ label: string; onPress: () => void }>;
  message: string;
  onRequestClose: () => void;
  title: string;
  visible: boolean;
};

const findDialog = (renderer: ReturnType<typeof create>, title: string) =>
  renderer.root.find((node) => (node.type as unknown) === "AppDialog" && node.props.title === title)
    .props as DialogProps;

const press = (renderer: ReturnType<typeof create>, accessibilityLabel: string) => {
  act(() => {
    (renderer.root.findByProps({ accessibilityLabel }).props as { onPress: () => void }).onPress();
  });
};

const renderScreen = async () => {
  let renderer: ReturnType<typeof create>;

  await act(async () => {
    renderer = create(<ShoppingScreen />);
    await flushAsyncWork();
  });

  return renderer!;
};

describe("ShoppingScreen", () => {
  beforeEach(() => {
    shoppingState.addItems.mockReset();
    shoppingState.canSyncShoppingList = false;
    shoppingState.clearCheckedItems.mockReset();
    shoppingState.deleteItem.mockReset();
    shoppingState.hasLoadedShoppingItems = true;
    shoppingState.isRefreshingShoppingList = false;
    shoppingState.refreshShoppingList.mockReset();
    shoppingState.setItemChecked.mockReset();
    shoppingState.shoppingError = null;
    shoppingState.shoppingItems = [];
    recipeState.savedRecipes = [];
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue(null);
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
  });

  it("shows a first-class empty state before items exist", async () => {
    const renderer = await renderScreen();

    const output = JSON.stringify(renderer.toJSON());
    expect(output).toContain("Your shopping list is empty.");
    expect(output).toContain("Add ingredients from any recipe.");
  });

  it("groups items by aisle in store order and prints friendly amounts", async () => {
    shoppingState.shoppingItems = [
      buildItem({ id: "milk", qty: 2 / 3, text: "milk", unit: "cup" }),
      buildItem({ id: "onions", qty: 2, recipeTitle: "Soup", text: "onions" })
    ];

    const renderer = await renderScreen();
    const output = JSON.stringify(renderer.toJSON());

    expect(output.indexOf("Produce")).toBeGreaterThan(-1);
    expect(output.indexOf("Produce")).toBeLessThan(output.indexOf("Dairy & Eggs"));
    expect(output).toContain("⅔ cup milk");
    expect(output).not.toContain("0.666");
    expect(output).not.toContain("On this device");
  });

  it("switches to recipe groups and remembers the choice", async () => {
    shoppingState.shoppingItems = [
      buildItem({ id: "onions", qty: 2, recipeId: "soup", recipeTitle: "Soup", text: "onions" }),
      buildItem({ id: "milk", text: "milk" })
    ];

    const renderer = await renderScreen();

    act(() => {
      (
        renderer.root.findByProps({ accessibilityLabel: "Group by recipe" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    const output = JSON.stringify(renderer.toJSON());
    expect(output).toContain("Everything else");
    expect(output).not.toContain("Dairy & Eggs");
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.shopping.groupMode.v1",
      "recipe"
    );
  });

  it("restores the saved grouping", async () => {
    asyncStorageMocks.getItem.mockResolvedValue("recipe");
    shoppingState.shoppingItems = [buildItem({ id: "milk", text: "milk" })];

    const renderer = await renderScreen();

    expect(
      renderer.root.findByProps({ accessibilityLabel: "Group by recipe" }).props.accessibilityState
    ).toEqual({ selected: true });
  });

  it("asks before clearing checked items", async () => {
    shoppingState.shoppingItems = [
      buildItem({ checked: true, id: "a", text: "milk" }),
      buildItem({ checked: true, id: "b", text: "eggs" }),
      buildItem({ id: "c", text: "bread" })
    ];

    const renderer = await renderScreen();
    const getDialog = () => findDialog(renderer, "Clear checked items?");

    expect(getDialog().visible).toBe(false);

    act(() => {
      (
        renderer.root.findByProps({ accessibilityLabel: "Clear checked items" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    expect(shoppingState.clearCheckedItems).not.toHaveBeenCalled();
    expect(getDialog()).toMatchObject({
      message: "The 2 items you checked off will be removed from this list.",
      title: "Clear checked items?",
      visible: true
    });

    act(() => {
      getDialog().actions[0]?.onPress();
    });
    expect(getDialog().visible).toBe(false);
    expect(shoppingState.clearCheckedItems).not.toHaveBeenCalled();

    act(() => {
      (
        renderer.root.findByProps({ accessibilityLabel: "Clear checked items" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });
    act(() => {
      getDialog().actions[1]?.onPress();
    });

    expect(shoppingState.clearCheckedItems).toHaveBeenCalledTimes(1);
  });

  it("expands an item to show the recipes it came from and others that use it", async () => {
    shoppingState.shoppingItems = [
      buildItem({
        id: "vinegar",
        qty: 1,
        recipeId: "bowl",
        recipeTitle: "Rice bowl",
        text: "rice vinegar",
        unit: "tbsp"
      })
    ];
    recipeState.savedRecipes = [
      {
        id: "bowl",
        recipe: { ingredients: [{ text: "1 tbsp rice vinegar" }], title: "Rice bowl" }
      },
      { id: "salad", recipe: { ingredients: [{ text: "2 tbsp rice vinegar" }], title: "Salad" } },
      { id: "soup", recipe: { ingredients: [{ text: "1 onion" }], title: "Soup" } }
    ];

    const renderer = await renderScreen();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Added from");

    press(renderer, "Show recipes for 1 Tbsp rice vinegar");

    const output = JSON.stringify(renderer.toJSON());
    expect(output).toContain("Added from");
    expect(output).toContain("Rice bowl");
    expect(output).toContain("Also in your cookbook");
    expect(output).toContain("Salad");
    expect(output).not.toContain("Soup");
  });

  it.each([
    [
      false,
      "Your shopping list is stored on this device. Family sharing unlocks a shared household list."
    ],
    [true, "Your shopping list is shared with your household when you refresh."]
  ])("explains the list in an info dialog (sync: %s)", async (canSync, message) => {
    shoppingState.canSyncShoppingList = canSync;
    const renderer = await renderScreen();

    expect(findDialog(renderer, "Shopping list")).toMatchObject({ message, visible: false });
    press(renderer, "Shopping list information");
    expect(findDialog(renderer, "Shopping list").visible).toBe(true);
    act(() => {
      findDialog(renderer, "Shopping list").onRequestClose();
    });
    expect(findDialog(renderer, "Shopping list").visible).toBe(false);
  });

  it("shows a syncing icon only on items waiting to sync", async () => {
    shoppingState.canSyncShoppingList = true;
    shoppingState.shoppingItems = [
      buildItem({ id: "honey", sync: { status: "dirty" }, text: "honey" }),
      buildItem({ id: "rice", sync: { status: "synced" }, text: "rice" })
    ];

    const renderer = await renderScreen();
    const indicators = renderer.root.findAll(
      (node) => typeof node.type === "string" && node.props.accessibilityLabel === "Syncing"
    );

    expect(indicators).toHaveLength(1);
  });
});
