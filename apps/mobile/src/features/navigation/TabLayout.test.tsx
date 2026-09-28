import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const reanimatedMocks = vi.hoisted(() => ({
  withSequence: vi.fn((...steps: unknown[]) => ({ steps })),
  withTiming: vi.fn((value: number, config: unknown) => ({ config, value }))
}));

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

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement("animated-view", props, children)
  },
  Easing: {
    bounce: "bounce",
    cubic: "cubic",
    out: (easing: unknown) => easing
  },
  ReduceMotion: {
    System: "system"
  },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: number) => React.useRef({ value }).current,
  withSequence: reanimatedMocks.withSequence,
  withTiming: reanimatedMocks.withTiming
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

import { CookbookTabIcon } from "./CookbookTabIcon";
import {
  flushRecipeBookBounce,
  requestRecipeBookBounce,
  subscribeToRecipeBookBounce,
  triggerRecipeBookBounce
} from "./recipeBookBounceEvents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ScreenOptions = (input: { route: { name: string } }) => {
  tabBarIcon: (input: { color: string; size: number }) => React.ReactElement<{
    name: string;
  }>;
};

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
    const screenOptions = tabs.props.screenOptions as ScreenOptions;

    expect(
      screenOptions({ route: { name: "import" } }).tabBarIcon({ color: "#29443b", size: 22 }).props
        .name
    ).toBe("plus-circle-outline");
    expect(
      screenOptions({ route: { name: "shopping" } }).tabBarIcon({ color: "#29443b", size: 22 })
        .props.name
    ).toBe("cart-outline");
  });

  it("gives the Cookbook tab the bouncing recipe-book icon", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<TabLayout />);
    });

    const tabs = renderer!.root.find((node) => (node.type as unknown) === "Tabs");
    const icon = (tabs.props.screenOptions as ScreenOptions)({
      route: { name: "index" }
    }).tabBarIcon({ color: "#29443b", size: 22 });

    expect(icon.type).toBe(CookbookTabIcon);
    expect(icon.props.name).toBe("book-open-variant");
  });

  it("plays a bounce requested on the recipe screen once a tab screen is focused again", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToRecipeBookBounce(listener);
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<TabLayout />);
    });

    const tabs = renderer!.root.find((node) => (node.type as unknown) === "Tabs");
    const listeners = tabs.props.screenListeners as { focus: () => void };

    listeners.focus();
    expect(listener).not.toHaveBeenCalled();

    requestRecipeBookBounce();
    expect(listener).not.toHaveBeenCalled();

    listeners.focus();
    expect(listener).toHaveBeenCalledTimes(1);

    listeners.focus();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(flushRecipeBookBounce()).toBe(false);

    unsubscribe();
  });
});

describe("CookbookTabIcon", () => {
  it("subscribes to the recipe-book bounce, respects reduced motion and unsubscribes", () => {
    reanimatedMocks.withSequence.mockClear();
    reanimatedMocks.withTiming.mockClear();
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookTabIcon color="#29443b" name="book-open-variant" size={22} />);
    });

    expect(reanimatedMocks.withSequence).not.toHaveBeenCalled();

    act(() => {
      triggerRecipeBookBounce();
    });

    expect(reanimatedMocks.withSequence).toHaveBeenCalledTimes(1);
    expect(reanimatedMocks.withTiming.mock.calls.map(([, config]) => config)).toEqual([
      expect.objectContaining({ reduceMotion: "system" }),
      expect.objectContaining({ reduceMotion: "system" })
    ]);

    act(() => {
      renderer!.unmount();
    });

    triggerRecipeBookBounce();
    expect(reanimatedMocks.withSequence).toHaveBeenCalledTimes(1);
  });
});
