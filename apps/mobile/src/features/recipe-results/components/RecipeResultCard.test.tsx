import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const storeReviewMocks = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  requestReview: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  trackMobileEvent: vi.fn()
}));

const animatedTimingMocks = vi.hoisted(() => ({
  defer: false,
  pending: [] as Array<() => void>
}));

vi.mock("../../../analytics/client", () => ({
  trackMobileEvent: analyticsMocks.trackMobileEvent
}));

const canonicalAppColors = vi.hoisted(() => {
  const hex = (value: string) => ["#", value].join("");

  return {
    accent: hex("29443b"),
    accentSoft: hex("dde7df"),
    background: hex("f4efe7"),
    border: hex("ddd2c3"),
    canvas: hex("fbf7f0"),
    muted: hex("6e685f"),
    surface: hex("fffdf8"),
    text: hex("1f211d")
  };
});

vi.mock("react-native", () => ({
  Alert: {
    alert: vi.fn()
  },
  Animated: {
    Text: ({ children, ...props }: { children: React.ReactNode }) =>
      React.createElement("animated-text", props, children),
    View: ({ children, ...props }: { children: React.ReactNode }) =>
      React.createElement("animated-view", props, children),
    Value: class {
      private value: number;

      constructor(value: number) {
        this.value = value;
      }

      interpolate() {
        return this.value;
      }

      setValue(value: number) {
        this.value = value;
      }
    },
    timing: (value: { setValue: (nextValue: number) => void }, config: { toValue: number }) => {
      let stopped = false;

      return {
        start: (callback?: (result: { finished: boolean }) => void) => {
          const complete = () => {
            if (stopped) {
              callback?.({ finished: false });
              return;
            }

            value.setValue(config.toValue);
            callback?.({ finished: true });
          };

          if (animatedTimingMocks.defer) {
            animatedTimingMocks.pending.push(complete);
            return;
          }

          complete();
        },
        stop: () => {
          stopped = true;
        }
      };
    }
  },
  Easing: {
    cubic: vi.fn((value: number) => value),
    out: vi.fn((easing: unknown) => easing)
  },
  Image: (props: Record<string, unknown>) => React.createElement("image", props),
  Modal: ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? React.createElement("modal", null, children) : null,
  Platform: {
    OS: "android"
  },
  Pressable: ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("pressable", props, children),
  ScrollView: ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("scroll-view", props, children),
  StyleSheet: {
    create: <T extends object>(styles: T) => styles
  },
  Switch: (props: Record<string, unknown>) => React.createElement("switch", props),
  Text: ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("text", props, children),
  useWindowDimensions: () => ({
    height: 800,
    scale: 1,
    fontScale: 1,
    width: 390
  }),
  View: ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("view", props, children)
}));

vi.mock("react-native-reanimated", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
  const React = require("react") as typeof import("react");
  const createReanimatedTransition = () => {
    const transition = {
      damping: vi.fn(() => transition),
      delay: vi.fn(() => transition),
      duration: vi.fn(() => transition),
      easing: vi.fn(() => transition),
      reduceMotion: vi.fn(() => transition),
      springify: vi.fn(() => transition),
      stiffness: vi.fn(() => transition),
      withInitialValues: vi.fn(() => transition)
    };

    return transition;
  };
  const ReanimatedView = ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("reanimated-view", props, children);
  const ReanimatedText = ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("reanimated-text", props, children);

  return {
    default: {
      Text: ReanimatedText,
      View: ReanimatedView
    },
    Easing: {
      bezier: vi.fn(() => (value: number) => value),
      cubic: vi.fn((value: number) => value),
      out: vi.fn((easing: unknown) => easing)
    },
    FadeIn: createReanimatedTransition(),
    FadeInDown: createReanimatedTransition(),
    FadeOutUp: createReanimatedTransition(),
    Layout: createReanimatedTransition(),
    ReduceMotion: {
      System: "system"
    },
    ZoomIn: createReanimatedTransition(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: number) => React.useRef({ value }).current,
    withTiming: (value: number) => value
  };
});

vi.mock("@linkdish/ui", () => ({
  appColors: canonicalAppColors,
  AppButton: ({
    disabled,
    label,
    onPress,
    style
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
    style?: unknown;
  }) => React.createElement("button", { disabled, onPress, style }, label),
  AppChip: ({
    children,
    label,
    tone
  }: {
    children?: React.ReactNode;
    label?: string;
    tone?: string;
  }) => React.createElement("chip", { tone }, children ?? label),
  AppSurface: ({ children }: { children: React.ReactNode }) =>
    React.createElement("surface", null, children),
  AppText: ({
    children,
    italic,
    style,
    tone
  }: {
    children: React.ReactNode;
    italic?: boolean;
    style?: unknown;
    tone?: string;
  }) => React.createElement("text", { italic, style, tone }, children)
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({
    color,
    name,
    size
  }: {
    color?: string;
    name: string;
    size?: number;
  }) => React.createElement("icon", { color, name, size }, name)
}));

vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: vi.fn(() => Promise.resolve()),
  deactivateKeepAwake: vi.fn()
}));

vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: {
    Success: "success",
    Warning: "warning"
  },
  notificationAsync: vi.fn(() => Promise.resolve()),
  selectionAsync: vi.fn(() => Promise.resolve())
}));

vi.mock("expo-store-review", () => ({
  isAvailableAsync: storeReviewMocks.isAvailableAsync,
  requestReview: storeReviewMocks.requestReview
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) =>
    React.createElement("safe-area-view", null, children)
}));

import { COOK_MODE_FINALE_TITLE } from "../../../theme/flavorCopy";

import { RecipeResultCard, getTimerRemainingSeconds } from "./RecipeResultCard";

import type { ReactTestInstance } from "react-test-renderer";

interface SwipeEvent {
  nativeEvent: {
    pageX: number;
    pageY: number;
  };
}

interface CookModeStepAreaProps {
  onTouchEnd?: (event: SwipeEvent) => void;
  onTouchStart?: (event: SwipeEvent) => void;
}

interface PressableProps {
  accessibilityState?: { checked?: boolean; disabled?: boolean };
  disabled?: boolean;
  onPress?: (event?: SwipeEvent) => void;
  onPressIn?: (event: SwipeEvent) => void;
  onTouchMove?: (event: SwipeEvent) => void;
}

interface SwitchProps {
  onValueChange?: (value: boolean) => void;
  value?: boolean;
}

const getProps = <TProps,>(node: ReactTestInstance) => node.props as TProps;
const getPrimitiveText = (node: ReactTestInstance) =>
  node.children
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const flushNextAnimatedTiming = () => {
  const complete = animatedTimingMocks.pending.shift();
  expect(complete).toBeDefined();
  complete?.();
};

describe("RecipeResultCard", () => {
  beforeEach(() => {
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue("true");
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    storeReviewMocks.isAvailableAsync.mockReset();
    storeReviewMocks.isAvailableAsync.mockResolvedValue(true);
    storeReviewMocks.requestReview.mockReset();
    storeReviewMocks.requestReview.mockResolvedValue(undefined);
    analyticsMocks.trackMobileEvent.mockReset();
    animatedTimingMocks.defer = false;
    animatedTimingMocks.pending.splice(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the consumer-facing recipe content without extraction metadata", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          notes="Use the wide pot."
          recipe={{
            title: "Grandma&#8217;s Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "1 &frac12; onions" }],
            steps: [{ index: 1, text: "Don&#8217;t boil." }],
            servings: "4&nbsp;servings",
            prepTimeMinutes: 10,
            cookTimeMinutes: 20,
            nutrition: {
              calories: "390&nbsp;kcal",
              protein: "18 g",
              carbohydrates: "42 g",
              fat: "16 g",
              fiber: "11 g",
              sugar: "7 g",
              sodium: "520 mg"
            },
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: "visible-text",
                prepTimeMinutes: "visible-text",
                cookTimeMinutes: "visible-text",
                nutrition: "visible-text"
              }
            }
          }}
        />
      );
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output).not.toContain("Extraction Notes");
    expect(output).not.toContain("article-pattern");
    expect(output).not.toContain("Check the seasoning.");
    expect(output).toContain("390 kcal");
    expect(output).toContain("Grandma’s Soup");
    expect(output).toContain("Webpage · 4 servings · Prep 10 min · Cook 20 min");
    expect(output).toContain("1 ½ onions");
    expect(output).toContain("Don’t boil.");
    expect(output).toContain("Ingredients");
    expect(output).toContain("Personal Notes");
    expect(output).toContain("Use the wide pot.");
  });

  it("lets saved recipe screens replace the preview eyebrow", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          eyebrowLabel="Recipe"
          recipe={{
            title: "Saved Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [{ index: 1, text: "Warm the stock." }],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Recipe");
    expect(output).not.toContain("Recipe Preview");
  });

  it("does not duplicate the active servings scale outside the scale pill", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [{ index: 1, text: "Warm the stock." }],
            servings: "4 servings",
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: "visible-text",
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    const scaleLabels = renderer!.root
      .findAllByType("text" as React.ElementType)
      .filter((node) => getPrimitiveText(node) === "1x");

    expect(scaleLabels).toHaveLength(1);
  });

  it("uses one muted label style for the full cook-mode step counter", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    });

    const stepNumber = renderer!.root
      .findAllByType("reanimated-text" as React.ElementType)
      .find((node) => node.children.includes("1"));

    expect(stepNumber).toBeDefined();
    expect(getProps<{ style?: { fontWeight?: string } }>(stepNumber!).style?.fontWeight).not.toBe(
      "900"
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('"fontWeight":"900"');
  });

  it("shows one anchored cook-mode hint card and persists dismissal", async () => {
    asyncStorageMocks.getItem.mockResolvedValue(null);
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    await act(async () => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
      await flushAsyncWork();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Tap the sides to move through steps.");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Tap ingredients to check them off.");

    const gotItButton = renderer!.root.findByProps({ children: "Got it" });

    await act(async () => {
      getProps<PressableProps>(gotItButton).onPress?.();
      await flushAsyncWork();
    });

    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith("linkdish.hasSeenCookModeHints", "true");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain(
      "Tap the sides to move through steps."
    );
  });

  it("accepts natural horizontal swipes while rejecting drags and vertical movement", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: "visible-text",
                prepTimeMinutes: "visible-text",
                cookTimeMinutes: "visible-text",
                nutrition: "visible-text"
              }
            }
          }}
        />
      );
    });

    const openButton = renderer!.root.findByProps({
      accessibilityLabel: "Open step-by-step cooking mode"
    });
    const openButtonProps = getProps<{ onPress: () => void }>(openButton);

    act(() => {
      openButtonProps.onPress();
    });

    const getCookModeStepArea = () =>
      renderer!.root
        .findAll((node) => String(node.type) === "view")
        .find((node) => {
          const props = getProps<CookModeStepAreaProps>(node);
          return typeof props.onTouchStart === "function" && typeof props.onTouchEnd === "function";
        });

    const swipeCookModeStepArea = (dx: number, dy = 0) => {
      const cookModeStepArea = getCookModeStepArea();

      expect(cookModeStepArea).toBeDefined();

      const props = getProps<CookModeStepAreaProps>(cookModeStepArea!);
      props.onTouchStart?.({ nativeEvent: { pageX: 200, pageY: 100 } });
      props.onTouchEnd?.({ nativeEvent: { pageX: 200 + dx, pageY: 100 + dy } });
    };

    const pressStepZone = (label: string, startX: number, endX: number) => {
      const props = getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: label })
      );
      const startEvent = { nativeEvent: { pageX: startX, pageY: 100 } };
      const endEvent = { nativeEvent: { pageX: endX, pageY: 100 } };

      props.onPressIn?.(startEvent);
      props.onTouchMove?.(endEvent);
      props.onPress?.(endEvent);
    };

    const expectCurrentStep = (step: 1 | 2) => {
      expect(
        renderer!.root.findAllByProps({
          accessibilityLabel: step === 1 ? "Next step" : "Finish cooking"
        }).length
      ).toBeGreaterThan(0);
      expect(
        renderer!.root.findAllByProps({
          accessibilityLabel: step === 1 ? "Finish cooking" : "Next step"
        })
      ).toHaveLength(0);
    };

    expectCurrentStep(1);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("arrow-left");

    act(() => {
      pressStepZone("Next step touch zone", 340, 320);
    });

    expectCurrentStep(1);

    act(() => {
      pressStepZone("Next step touch zone", 340, 336);
    });

    expectCurrentStep(2);

    act(() => {
      pressStepZone("Previous step touch zone", 50, 54);
    });

    expectCurrentStep(1);

    act(() => {
      swipeCookModeStepArea(-44, 28);
    });

    expectCurrentStep(2);
    expect(JSON.stringify(renderer!.toJSON())).toContain("arrow-left");

    act(() => {
      swipeCookModeStepArea(90, 65);
    });

    expectCurrentStep(1);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("arrow-left");

    act(() => {
      swipeCookModeStepArea(-34, 4);
    });

    expectCurrentStep(1);

    act(() => {
      swipeCookModeStepArea(-50, 48);
    });

    expectCurrentStep(1);
  });

  it("shows a finale after the last cooking step and returns to the final step with a back swipe", () => {
    const onCookModeFinish = vi.fn();
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          onCookModeFinish={onCookModeFinish}
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    const openButton = renderer!.root.findByProps({
      accessibilityLabel: "Open step-by-step cooking mode"
    });

    act(() => {
      getProps<PressableProps>(openButton).onPress?.();
    });

    expect(analyticsMocks.trackMobileEvent).toHaveBeenCalledWith({
      eventName: "cook_mode_started",
      routeOrScreen: "recipe",
      properties: {
        entry_point: "recipe_detail",
        step_count: 2
      }
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Next step" })
      ).onPress?.();
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Finish cooking" })
      ).onPress?.();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain(COOK_MODE_FINALE_TITLE);
    expect(JSON.stringify(renderer!.toJSON())).toContain("You cooked Soup.");
    expect(analyticsMocks.trackMobileEvent).toHaveBeenCalledWith({
      eventName: "cook_mode_completed",
      routeOrScreen: "recipe",
      properties: {
        elapsed_seconds: 0,
        step_count: 2
      }
    });
    expect(onCookModeFinish).toHaveBeenCalledTimes(1);

    const cookModeStepArea = renderer!.root
      .findAll((node) => String(node.type) === "view")
      .find((node) => {
        const props = getProps<CookModeStepAreaProps>(node);
        return typeof props.onTouchStart === "function" && typeof props.onTouchEnd === "function";
      });

    expect(cookModeStepArea).toBeDefined();

    act(() => {
      const props = getProps<CookModeStepAreaProps>(cookModeStepArea!);
      props.onTouchStart?.({ nativeEvent: { pageX: 120, pageY: 100 } });
      props.onTouchEnd?.({ nativeEvent: { pageX: 200, pageY: 100 } });
    });

    expect(JSON.stringify(renderer!.toJSON())).not.toContain(COOK_MODE_FINALE_TITLE);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Finish the soup.");

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Finish cooking" })
      ).onPress?.();
    });

    expect(onCookModeFinish).toHaveBeenCalledTimes(1);
  });

  it("blocks finishing until the incoming final-step animation completes", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    });

    animatedTimingMocks.defer = true;

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Next step" })
      ).onPress?.();
    });

    const animatingNextButton = renderer!.root.findByProps({ accessibilityLabel: "Next step" });
    expect(getProps<PressableProps>(animatingNextButton).disabled).toBe(true);
    expect(animatedTimingMocks.pending).toHaveLength(1);

    act(() => {
      getProps<PressableProps>(animatingNextButton).onPress?.();
    });

    expect(animatedTimingMocks.pending).toHaveLength(1);

    act(() => {
      flushNextAnimatedTiming();
    });

    const animatingFinishButton = renderer!.root.findByProps({
      accessibilityLabel: "Finish cooking"
    });
    expect(getProps<PressableProps>(animatingFinishButton).disabled).toBe(true);
    expect(animatedTimingMocks.pending).toHaveLength(1);

    act(() => {
      getProps<PressableProps>(animatingFinishButton).onPress?.();
    });

    expect(JSON.stringify(renderer!.toJSON())).not.toContain(COOK_MODE_FINALE_TITLE);

    act(() => {
      flushNextAnimatedTiming();
    });

    const finishButton = renderer!.root.findByProps({ accessibilityLabel: "Finish cooking" });
    expect(getProps<PressableProps>(finishButton).disabled).toBe(false);

    act(() => {
      getProps<PressableProps>(finishButton).onPress?.();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain(COOK_MODE_FINALE_TITLE);
  });

  it("ignores a stale step callback after cook mode closes and reopens", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    const openCookMode = () => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    };

    act(() => {
      openCookMode();
    });

    animatedTimingMocks.defer = true;

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Next step" })
      ).onPress?.();
    });

    expect(animatedTimingMocks.pending).toHaveLength(1);

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Close cooking mode" })
      ).onPress?.();
    });

    act(() => {
      openCookMode();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Start the soup.");

    act(() => {
      flushNextAnimatedTiming();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Start the soup.");
    expect(renderer!.root.findAllByProps({ accessibilityLabel: "Finish cooking" })).toHaveLength(0);
    expect(
      getProps<PressableProps>(renderer!.root.findByProps({ accessibilityLabel: "Next step" }))
        .disabled
    ).toBe(false);
    expect(animatedTimingMocks.pending).toHaveLength(0);
  });

  it("requests an in-app review once after the cook mode finale lands", async () => {
    vi.useFakeTimers();
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === "linkdish.reviewRequested.v1" ? null : "true")
    );
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [
              { index: 1, text: "Start the soup." },
              { index: 2, text: "Finish the soup." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Next step" })
      ).onPress?.();
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Finish cooking" })
      ).onPress?.();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain(COOK_MODE_FINALE_TITLE);
    expect(storeReviewMocks.requestReview).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1499);
      await flushAsyncWork();
    });

    expect(storeReviewMocks.requestReview).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushAsyncWork();
    });

    expect(storeReviewMocks.isAvailableAsync).toHaveBeenCalledTimes(1);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith("linkdish.reviewRequested.v1", "true");
    expect(storeReviewMocks.requestReview).toHaveBeenCalledTimes(1);
  });

  it("skips the cook mode finale review request after the once-ever flag is set", async () => {
    vi.useFakeTimers();
    asyncStorageMocks.getItem.mockResolvedValue("true");
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [{ index: 1, text: "Finish the soup." }],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Finish cooking" })
      ).onPress?.();
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await flushAsyncWork();
    });

    expect(storeReviewMocks.isAvailableAsync).not.toHaveBeenCalled();
    expect(storeReviewMocks.requestReview).not.toHaveBeenCalled();
  });

  it("shows ingredient sections in the recipe and cook mode", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Layer Cake",
            sourceUrl: "https://linkdish.app/image-imports/cake",
            sourceType: "image",
            ingredients: [
              { section: "Cake", text: "2 cups flour" },
              { section: "Cake", text: "1 cup sugar" },
              { section: "Frosting", text: "1 cup cocoa powder" }
            ],
            steps: [
              { index: 1, text: "Mix the Cake ingredients." },
              { index: 2, text: "Beat the Frosting ingredients." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "llm",
                ingredients: "llm",
                steps: "llm",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Cake");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Frosting");

    const openButton = renderer!.root.findByProps({
      accessibilityLabel: "Open step-by-step cooking mode"
    });
    const openButtonProps = getProps<{ onPress: () => void }>(openButton);

    act(() => {
      openButtonProps.onPress();
    });

    const modal = renderer!.root.findByType("modal" as React.ElementType);
    const getModalTexts = () =>
      modal
        .findAll((node) => String(node.type) === "text" || String(node.type) === "animated-text")
        .map((node) =>
          node.children
            .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
            .join("")
        );

    let texts = getModalTexts();
    expect(texts).toContain("Ingredients");
    expect(texts).not.toContain("Ingredients Reference");
    expect(texts).not.toContain("Cake");
    expect(texts).not.toContain("Frosting");
    expect(texts).not.toContain("2 cups flour");

    const toggleButton = renderer!.root.findByProps({
      accessibilityLabel: "Toggle ingredients visibility"
    });
    const toggleButtonProps = getProps<{ onPress: () => void }>(toggleButton);
    const nextStepTouchZone = renderer!.root.findByProps({
      accessibilityLabel: "Next step touch zone"
    });
    const hasIngredientInteractionLayer = (node: ReactTestInstance) => {
      const style = getProps<{ style?: unknown }>(node).style;

      return (
        typeof style === "object" &&
        style !== null &&
        !Array.isArray(style) &&
        (style as Record<string, unknown>).zIndex === 3
      );
    };
    let ingredientReference = toggleButton.parent;
    while (ingredientReference && !hasIngredientInteractionLayer(ingredientReference)) {
      ingredientReference = ingredientReference.parent;
    }

    let nextStepTouchZoneAncestor = nextStepTouchZone.parent;
    let isTouchZoneInsideStepScroller = false;
    while (nextStepTouchZoneAncestor) {
      if (String(nextStepTouchZoneAncestor.type) === "scroll-view") {
        isTouchZoneInsideStepScroller = true;
        break;
      }
      nextStepTouchZoneAncestor = nextStepTouchZoneAncestor.parent;
    }

    expect(isTouchZoneInsideStepScroller).toBe(true);
    expect(Boolean(ingredientReference)).toBe(true);
    expect(
      ingredientReference
        ? getProps<{ style: Record<string, unknown> }>(ingredientReference).style
        : {}
    ).toMatchObject({ position: "relative", zIndex: 3 });
    expect(
      getProps<{ style: Array<Record<string, unknown>> }>(nextStepTouchZone).style[0]
    ).toMatchObject({ zIndex: 2 });

    act(() => {
      toggleButtonProps.onPress();
    });

    texts = getModalTexts();
    expect(texts).toContain("Cake");
    expect(texts).toContain("Frosting");
    expect(texts).toContain("2 cups flour");
    expect(texts).toContain("1 cup cocoa powder");

    const getIngredientCheckbox = (label: string) =>
      renderer!.root
        .findAll((node) => {
          const props = getProps<{
            accessibilityLabel?: string;
            accessibilityRole?: string;
          }>(node);
          return props.accessibilityLabel === label && props.accessibilityRole === "checkbox";
        })
        .at(0);

    let flourCheckbox = getIngredientCheckbox("Toggle 2 cups flour");
    expect(flourCheckbox).toBeDefined();
    expect(getProps<PressableProps>(flourCheckbox!).accessibilityState?.checked).toBe(false);

    act(() => {
      getProps<PressableProps>(flourCheckbox!).onPress?.();
    });

    flourCheckbox = getIngredientCheckbox("Toggle 2 cups flour");
    expect(getProps<PressableProps>(flourCheckbox!).accessibilityState?.checked).toBe(true);
  });

  it("collapses blank method divider steps and renders named sections as labels", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Layer Cake",
            sourceUrl: "https://linkdish.app/image-imports/cake",
            sourceType: "image",
            ingredients: [{ text: "2 cups flour" }],
            steps: [
              { index: 1, text: "Mix the batter." },
              { index: 2, text: "Frosting:" },
              { index: 3, text: "   " },
              { index: 4, text: "Beat the frosting." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "llm",
                ingredients: "llm",
                steps: "llm",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    const texts = renderer!.root
      .findAll((node) => String(node.type) === "text" || String(node.type) === "animated-text")
      .map((node) =>
        node.children
          .map((child) =>
            typeof child === "string" || typeof child === "number" ? String(child) : ""
          )
          .join("")
      )
      .filter(Boolean);

    expect(texts).toContain("Frosting");
    expect(texts).toContain("Beat the frosting.");
    expect(texts).toContain("1");
    expect(texts).toContain("2");
    expect(texts).not.toContain("3");
    expect(texts).not.toContain("4");
  });

  it("defaults keep-awake on and lets cooks toggle it off", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "Stock" }],
            steps: [{ index: 1, text: "Start the soup." }],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    const openButton = renderer!.root.findByProps({
      accessibilityLabel: "Open step-by-step cooking mode"
    });

    act(() => {
      getProps<PressableProps>(openButton).onPress?.();
    });

    const getKeepAwakeIcon = () =>
      renderer!.root.findAllByType("icon" as React.ElementType).find((node) => {
        const props = getProps<{ name?: string }>(node);
        return props.name === "brightness-5";
      });

    expect(getKeepAwakeIcon()?.props.color).toBe(canonicalAppColors.accent);

    const keepAwakeSwitch = renderer!.root.findByType("switch" as React.ElementType);
    expect(getProps<SwitchProps>(keepAwakeSwitch).value).toBe(true);

    act(() => {
      getProps<SwitchProps>(keepAwakeSwitch).onValueChange?.(false);
    });

    expect(getKeepAwakeIcon()?.props.color).toBe(canonicalAppColors.muted);
  });

  it("shows timer chips for duration steps but not temperature-only steps", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Roast",
            sourceUrl: "https://example.com/roast",
            sourceType: "article",
            ingredients: [{ text: "2 potatoes" }],
            steps: [
              { index: 1, text: "Roast for 10 minutes at 400°F." },
              { index: 2, text: "Bake at 350°F until golden." }
            ],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    });

    expect(
      renderer!.root.findAllByProps({ accessibilityLabel: "Start 10 minutes timer" })
    ).not.toHaveLength(0);

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Next step" })
      ).onPress?.();
    });

    expect(renderer!.root.findAllByProps({ accessibilityLabel: "Start 350 timer" })).toHaveLength(
      0
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("350 ▸");
  });

  it("shows matched ingredient quantities under the current cooking step", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Cake",
            sourceUrl: "https://example.com/cake",
            sourceType: "article",
            ingredients: [{ text: "2 cups flour" }, { text: "1 cup sugar" }],
            steps: [{ index: 1, text: "Fold in the flour." }],
            servings: null,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: null,
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Open step-by-step cooking mode" })
      ).onPress?.();
    });

    const modal = renderer!.root.findByType("modal" as React.ElementType);
    const modalText = modal
      .findAll((node) => String(node.type) === "text" || String(node.type) === "animated-text")
      .map((node) =>
        node.children
          .map((child) =>
            typeof child === "string" || typeof child === "number" ? String(child) : ""
          )
          .join("")
      )
      .join("\n");
    expect(modalText).toContain("2 cups flour");
    expect(modalText).not.toContain("1 cup sugar");
  });

  it("scales confident ingredients and shows an honesty note for unscalable lines", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <RecipeResultCard
          recipe={{
            title: "Soup",
            sourceUrl: "https://example.com/soup",
            sourceType: "article",
            ingredients: [{ text: "2 cups stock" }, { text: "Salt to taste" }],
            steps: [{ index: 1, text: "Warm the stock." }],
            servings: "4 servings",
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            nutrition: null,
            confidence: {
              score: 0.8,
              summary: "Confident extraction.",
              missingFields: [],
              notes: [],
              fieldProvenance: {
                title: "visible-text",
                ingredients: "visible-text",
                steps: "visible-text",
                servings: "visible-text",
                prepTimeMinutes: null,
                cookTimeMinutes: null,
                nutrition: null
              }
            }
          }}
        />
      );
    });

    act(() => {
      getProps<PressableProps>(
        renderer!.root.findByProps({ accessibilityLabel: "Scale recipe to 2x" })
      ).onPress?.();
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("4 cups stock");
    expect(output).toContain("Salt to taste");
    expect(output).toContain("Some ingredients can't be scaled automatically");
  });

  it("computes timer remaining time from the Date deadline", () => {
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(1_000);

    const deadlineMs = Date.now() + 10 * 60 * 1000;
    dateNow.mockReturnValue(1_000 + 4 * 60 * 1000 + 250);

    expect(getTimerRemainingSeconds(deadlineMs, Date.now())).toBe(360);
  });
});
