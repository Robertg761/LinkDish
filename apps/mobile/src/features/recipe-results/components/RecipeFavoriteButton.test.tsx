import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hapticMocks = vi.hoisted(() => ({
  selectionTick: vi.fn()
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: (props: { color: string; name: string }) =>
    React.createElement("MaterialCommunityIcons", props)
}));

vi.mock("react-native", () => ({
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("Pressable", props, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  }
}));

vi.mock("../../../lib/haptics", () => hapticMocks);

vi.mock("../../../theme/tokens", () => ({
  appColors: {
    muted: "#6e685f",
    tomato: "#b95233"
  }
}));

import { RecipeFavoriteButton } from "./RecipeFavoriteButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RecipeFavoriteButton", () => {
  beforeEach(() => {
    hapticMocks.selectionTick.mockReset();
  });

  it("hearts an unfavorited recipe", () => {
    const onToggle = vi.fn();
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<RecipeFavoriteButton favorite={false} onToggle={onToggle} />);
    });

    const button = renderer!.root.findByProps({ testID: "recipe-favorite-button" });
    expect(button.props.accessibilityLabel).toBe("Add to favorites");
    expect(renderer!.root.findByType("MaterialCommunityIcons" as never).props).toMatchObject({
      color: "#6e685f",
      name: "heart-outline"
    });

    act(() => {
      (button.props as { onPress: () => void }).onPress();
    });

    expect(onToggle).toHaveBeenCalledWith(true);
    expect(hapticMocks.selectionTick).toHaveBeenCalledTimes(1);
  });

  it("un-hearts a favorite in tomato", () => {
    const onToggle = vi.fn();
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<RecipeFavoriteButton favorite onToggle={onToggle} />);
    });

    const button = renderer!.root.findByProps({ testID: "recipe-favorite-button" });
    expect(button.props).toMatchObject({
      accessibilityLabel: "Remove from favorites",
      accessibilityState: { selected: true }
    });
    expect(renderer!.root.findByType("MaterialCommunityIcons" as never).props.color).toBe(
      "#b95233"
    );

    act(() => {
      (button.props as { onPress: () => void }).onPress();
    });

    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
