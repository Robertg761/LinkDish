import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shoppingState = vi.hoisted(() => ({
  addItems: vi.fn(),
  canSyncShoppingList: false,
  deleteItem: vi.fn(),
  hasLoadedShoppingItems: true,
  isRefreshingShoppingList: false,
  refreshShoppingList: vi.fn(),
  setItemChecked: vi.fn(),
  shoppingError: null as string | null,
  shoppingItems: [] as unknown[]
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
  AppSurface: ({ children }: { children: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppText", null, children)
}));

vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => callback()
}));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
  }) => React.createElement("Pressable", { onPress }, children),
  RefreshControl: (props: Record<string, unknown>) => React.createElement("RefreshControl", props),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("ScrollView", null, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  TextInput: (props: Record<string, unknown>) => React.createElement("TextInput", props),
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("View", null, children)
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("SafeAreaView", null, children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
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
    muted: "#6e685f",
    placeholder: "rgba(110, 104, 95, 0.6)",
    surface: "#fffdf8",
    text: "#1f211d"
  },
  appSpacing: {
    lg: 16,
    md: 12,
    sm: 8,
    xl: 20
  }
}));

import ShoppingScreen from "../../../app/(tabs)/shopping";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ShoppingScreen", () => {
  beforeEach(() => {
    shoppingState.addItems.mockReset();
    shoppingState.canSyncShoppingList = false;
    shoppingState.deleteItem.mockReset();
    shoppingState.hasLoadedShoppingItems = true;
    shoppingState.isRefreshingShoppingList = false;
    shoppingState.refreshShoppingList.mockReset();
    shoppingState.setItemChecked.mockReset();
    shoppingState.shoppingError = null;
    shoppingState.shoppingItems = [];
  });

  it("shows a first-class empty state before items exist", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<ShoppingScreen />);
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Your shopping list is empty.");
    expect(output).toContain("Add ingredients from any recipe.");
  });
});
