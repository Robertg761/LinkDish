import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { TabBarVisibilityProvider, useTabBarScroll, useTabBarVisibility } from "./TabBarVisibility";

import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("scrolling the tab pages", () => {
  it("hides after scrolling down and reveals after scrolling up or reaching the top", () => {
    let scroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void = () => {};
    let visible = true;
    const Observer = () => {
      scroll = useTabBarScroll();
      visible = useTabBarVisibility().visible;
      return null;
    };
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <TabBarVisibilityProvider>
          <Observer />
        </TabBarVisibilityProvider>
      );
    });
    const move = (y: number) =>
      act(() =>
        scroll({ nativeEvent: { contentOffset: { y } } } as NativeSyntheticEvent<NativeScrollEvent>)
      );
    move(10);
    expect(visible).toBe(true);
    move(30);
    expect(visible).toBe(false);
    move(24);
    expect(visible).toBe(false);
    move(10);
    expect(visible).toBe(true);
    move(40);
    expect(visible).toBe(false);
    move(0);
    expect(visible).toBe(true);
    act(() => renderer!.unmount());
  });
});
