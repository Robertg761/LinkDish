import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn()
}));

vi.mock("@linkdish/ui", () => ({
  AppButton: ({
    label,
    onPress,
    variant
  }: {
    label: string;
    onPress: () => void;
    variant?: string;
  }) => React.createElement("AppButton", { label, onPress, variant }, label),
  AppChip: ({ label }: { label: string }) => React.createElement("AppChip", { label }, label),
  AppSurface: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppText", null, children)
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("expo-router", () => ({
  router: routerMocks
}));

vi.mock("react-native", () => ({
  Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? React.createElement("Modal", null, children) : null,
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("Pressable", props, children),
  StyleSheet: {
    absoluteFillObject: {},
    create: <T,>(styles: T) => styles
  },
  useWindowDimensions: () => ({ height: 812, width: 390 }),
  View: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("View", props, children)
}));

vi.mock("../../theme/tokens", () => ({
  appColors: {
    accent: "#29443b",
    accentSoft: "#dde7df",
    backdrop: "rgba(31, 33, 29, 0.4)",
    border: "#ddd2c3",
    surface: "#fffdf8"
  },
  appSpacing: {
    lg: 16,
    md: 12,
    sm: 8,
    xl: 20
  }
}));

import { FirstRunOnboardingGate, ONBOARDING_STORAGE_KEY } from "./FirstRunOnboardingGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("FirstRunOnboardingGate", () => {
  beforeEach(() => {
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    routerMocks.replace.mockReset();
  });

  it("does not render after the onboarding flag is set", async () => {
    asyncStorageMocks.getItem.mockResolvedValue("true");
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<FirstRunOnboardingGate />);
      await flushAsyncWork();
    });

    expect(renderer!.toJSON()).toBeNull();
  });

  it("persists the onboarding flag and lands on Cookbook when skipped", async () => {
    asyncStorageMocks.getItem.mockResolvedValue(null);
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<FirstRunOnboardingGate />);
      await flushAsyncWork();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Save recipes from anywhere");

    const skipButton = renderer!.root.findAllByProps({ label: "Skip" }).at(0);
    const skipProps = skipButton?.props as { onPress?: () => void } | undefined;

    await act(async () => {
      skipProps?.onPress?.();
      await flushAsyncWork();
    });

    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY, "true");
    expect(routerMocks.replace).toHaveBeenCalledWith("/");
  });

  it("uses dots for progress and hides Skip on the last frame", async () => {
    asyncStorageMocks.getItem.mockResolvedValue(null);
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<FirstRunOnboardingGate />);
      await flushAsyncWork();
    });

    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Frame 1 of 3");
    expect(
      renderer!.root.findAll(
        (node) => String(node.type) === "AppButton" && node.props.label === "Skip"
      )
    ).toHaveLength(1);

    const pressNext = () => {
      const nextButton = renderer!.root.findByProps({ label: "Next" });
      const nextProps = nextButton.props as { onPress: () => void };
      nextProps.onPress();
    };

    act(() => {
      pressNext();
    });
    act(() => {
      pressNext();
    });

    expect(
      renderer!.root.findAll(
        (node) => String(node.type) === "AppButton" && node.props.label === "Skip"
      )
    ).toHaveLength(0);
    expect(
      renderer!.root.findAll(
        (node) => String(node.type) === "AppButton" && node.props.label === "Start cooking"
      )
    ).not.toHaveLength(0);
  });
});
