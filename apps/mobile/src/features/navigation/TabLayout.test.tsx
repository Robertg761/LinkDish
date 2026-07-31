import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
}));

vi.mock("expo-router", () => {
  const Tabs = ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("Tabs", props, children);

  Tabs.Screen = ({ name, options }: { name: string; options: { title: string } }) =>
    React.createElement("Tabs.Screen", { name, options });

  return {
    Tabs
  };
});

vi.mock("react-native", () => ({
  Platform: {
    OS: "android"
  },
  StyleSheet: {
    create: <T,>(styles: T) => styles
  }
}));

vi.mock("../../theme/tokens", () => ({
  appColors: {
    accent: "#29443b",
    border: "#ddd2c3",
    muted: "#6e685f",
    surface: "#fffdf8"
  }
}));

import TabLayout from "../../../app/(tabs)/_layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TabLayout", () => {
  it("renders Cookbook, Add, Shopping, and Household in order", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<TabLayout />);
    });

    const screens = renderer!.root.findAll((node) => (node.type as unknown) === "Tabs.Screen");

    expect(
      screens.map((screen) => {
        const props = screen.props as { name: string; options: { title: string } };

        return {
          name: props.name,
          title: props.options.title
        };
      })
    ).toEqual([
      { name: "index", title: "Cookbook" },
      { name: "import", title: "Add" },
      { name: "shopping", title: "Shopping" },
      { name: "account", title: "Household" }
    ]);
  });

  it("uses Add and Shopping icons without renaming the import route", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<TabLayout />);
    });

    const tabs = renderer!.root.find((node) => (node.type as unknown) === "Tabs");
    const screenOptions = tabs.props.screenOptions as (input: {
      route: { name: string };
    }) => {
      tabBarIcon: (input: { color: string; size: number }) => React.ReactElement<{
        name: string;
      }>;
    };

    expect(
      screenOptions({ route: { name: "import" } }).tabBarIcon({ color: "#29443b", size: 22 })
        .props.name
    ).toBe("plus-circle-outline");
    expect(
      screenOptions({ route: { name: "shopping" } }).tabBarIcon({ color: "#29443b", size: 22 })
        .props.name
    ).toBe("cart-outline");
  });
});
