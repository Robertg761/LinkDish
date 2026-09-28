import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn()
}));

const upgradeMomentMocks = vi.hoisted(() => ({
  showUpgradeMoment: vi.fn()
}));

const hapticMocks = vi.hoisted(() => ({
  selectionTick: vi.fn(),
  warn: vi.fn()
}));

const recipeImageMocks = vi.hoisted(() => ({
  buildProxiedRecipeImageUrl: vi.fn<() => string | null>(() => null)
}));

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const savedRecipesState = vi.hoisted(() => ({
  canUseSharedRecipeBook: false,
  cloneRecipe: vi.fn(),
  cloneSharedRecipe: vi.fn(),
  deleteSharedRecipe: vi.fn(),
  hasLoadedSavedRecipes: true,
  hasLoadedSharedRecipes: true,
  removeRecipe: vi.fn(),
  savedRecipes: [] as unknown[],
  setShareMode: vi.fn(),
  sharedRecipeError: null as string | null,
  sharedRecipes: [] as unknown[],
  shareMode: "none",
  setRecipeFavorite: vi.fn(),
  shareRecipe: vi.fn(),
  unshareRecipe: vi.fn()
}));

const accountState = vi.hoisted(() => ({
  isSignedIn: false,
  user: {
    id: "user_1"
  } as { id: string } | null
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("@linkdish/ui", () => ({
  AppButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    React.createElement("AppButton", { onPress }, label),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppText", null, children),
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
    xl: 20,
    xs: 4,
    xxl: 24
  }
}));

vi.mock("expo-router", () => ({
  router: routerMocks,
  useLocalSearchParams: () => ({}),
  usePathname: () => "/"
}));

vi.mock("react-native", () => ({
  FlatList: ({
    ListFooterComponent,
    ListHeaderComponent,
    data,
    keyExtractor,
    renderItem,
    ...props
  }: {
    ListFooterComponent?: React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    data: unknown[];
    keyExtractor: (item: unknown, index: number) => string;
    renderItem: (info: { index: number; item: unknown }) => React.ReactNode;
  }) =>
    React.createElement(
      "flat-list",
      props,
      ListHeaderComponent,
      ...data.map((item, index) =>
        React.createElement(
          React.Fragment,
          { key: keyExtractor(item, index) },
          renderItem({ index, item })
        )
      ),
      ListFooterComponent
    ),
  Image: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("Image", props, children),
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("pressable", props, children),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("scroll-view", null, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  TextInput: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("TextInput", props, children),
  View: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("view", props, children)
}));

vi.mock("../../components/AppDialog", () => ({
  AppDialog: (props: {
    actions: Array<{ label: string; onPress: () => void }>;
    message: string;
    title: string;
    visible: boolean;
  }) => React.createElement("AppDialog", props)
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    // Reanimated only plays `entering` when a view mounts, so record the mount-time value.
    View: ({ children, ...props }: { children?: React.ReactNode; entering?: unknown }) => {
      const mountEntering = React.useRef(props.entering).current;

      return React.createElement("animated-view", { ...props, mountEntering }, children);
    }
  },
  Easing: {
    cubic: vi.fn((value: number) => value),
    out: vi.fn((easing: unknown) => easing)
  },
  FadeInDown: {
    duration: () => ({
      delay: (delay: number) => ({
        easing: () => ({
          reduceMotion: (reduceMotion: string) => ({ delay, reduceMotion })
        })
      })
    })
  },
  ReduceMotion: {
    System: "system"
  }
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("../billing/UpgradeMomentContext", () => ({
  useOptionalUpgradeMoment: () => ({
    showUpgradeMoment: upgradeMomentMocks.showUpgradeMoment
  })
}));

vi.mock("../saved-recipes/SavedRecipesContext", () => ({
  useSavedRecipes: () => savedRecipesState
}));

vi.mock("../../lib/recipeImage", () => ({
  buildProxiedRecipeImageUrl: recipeImageMocks.buildProxiedRecipeImageUrl,
  getRecipeMonogram: () => "T"
}));

vi.mock("../../lib/haptics", () => ({
  selectionTick: hapticMocks.selectionTick,
  warn: hapticMocks.warn
}));

import { CookbookScreen } from "./CookbookScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const savedRecipe = {
  fetchMode: "primary",
  id: "saved_1",
  provenance: "extracted",
  recipe: {
    cookTimeMinutes: 20,
    ingredients: [{ items: ["1 tomato"], title: null }],
    instructions: [{ steps: ["Cook"], title: null }],
    prepTimeMinutes: 10,
    servings: "4 servings",
    sourceType: "recipe-webpage",
    sourceUrl: "https://example.com",
    title: "Tomato Toast"
  },
  savedAt: "2026-07-04T00:00:00.000Z",
  strategy: "html",
  timesCooked: 0,
  warnings: []
};

describe("CookbookScreen navigation and sharing", () => {
  beforeEach(() => {
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    hapticMocks.selectionTick.mockReset();
    hapticMocks.warn.mockReset();
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue(null);
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    upgradeMomentMocks.showUpgradeMoment.mockReset();
    recipeImageMocks.buildProxiedRecipeImageUrl.mockReset();
    recipeImageMocks.buildProxiedRecipeImageUrl.mockReturnValue(null);
    savedRecipesState.canUseSharedRecipeBook = false;
    savedRecipesState.cloneRecipe.mockReset();
    savedRecipesState.cloneSharedRecipe.mockReset();
    savedRecipesState.deleteSharedRecipe.mockReset();
    savedRecipesState.hasLoadedSavedRecipes = true;
    savedRecipesState.hasLoadedSharedRecipes = true;
    savedRecipesState.removeRecipe.mockReset();
    savedRecipesState.savedRecipes = [];
    savedRecipesState.setShareMode.mockReset();
    savedRecipesState.sharedRecipeError = null;
    savedRecipesState.sharedRecipes = [];
    savedRecipesState.shareMode = "none";
    savedRecipesState.setRecipeFavorite.mockReset();
    savedRecipesState.shareRecipe.mockReset();
    savedRecipesState.unshareRecipe.mockReset();
    accountState.isSignedIn = false;
    accountState.user = { id: "user_1" };
  });

  it("sends the empty-state CTA to the Import tab", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const importButton = renderer!.root.findByProps({ children: "Import a recipe" });
    const importButtonProps = importButton.props as { onPress: () => void };

    act(() => {
      importButtonProps.onPress();
    });

    expect(routerMocks.push).toHaveBeenCalledWith("/import");
  });

  it("requires confirmation before removing a Cookbook row recipe", () => {
    savedRecipesState.savedRecipes = [savedRecipe];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const removeButton = renderer!.root.findByProps({
      accessibilityLabel: "Remove recipe"
    });

    act(() => {
      (removeButton.props as { onPress: () => void }).onPress();
    });

    expect(savedRecipesState.removeRecipe).not.toHaveBeenCalled();

    const dialog = renderer!.root.findByType("AppDialog" as never);
    const dialogProps = dialog.props as {
      actions: Array<{ label: string; onPress: () => void }>;
      message: string;
      title: string;
      visible: boolean;
    };

    expect(dialogProps.visible).toBe(true);
    expect(dialogProps.title).toBe("Remove recipe?");
    expect(dialogProps.message).toBe(
      "\u201cTomato Toast\u201d will be removed from your cookbook."
    );

    act(() => {
      dialogProps.actions[0]?.onPress();
    });
    expect(savedRecipesState.removeRecipe).not.toHaveBeenCalled();

    act(() => {
      (removeButton.props as { onPress: () => void }).onPress();
    });

    const reopenedDialog = renderer!.root.findByType("AppDialog" as never);
    const reopenedActions = (reopenedDialog.props as typeof dialogProps).actions;

    act(() => {
      reopenedActions[1]?.onPress();
    });

    expect(hapticMocks.warn).toHaveBeenCalled();
    expect(savedRecipesState.removeRecipe).toHaveBeenCalledWith("saved_1");
  });

  it("keeps Family sharing controls behind the Cookbook overflow row", () => {
    savedRecipesState.canUseSharedRecipeBook = true;
    savedRecipesState.savedRecipes = [savedRecipe];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Share all");

    const sharingText = renderer!.root.findByProps({ children: "Family sharing" });
    let sharingButton = sharingText.parent;
    while (sharingButton && (sharingButton.type as unknown) !== "pressable") {
      sharingButton = sharingButton.parent;
    }

    const sharingButtonProps = sharingButton?.props as { onPress?: () => void } | undefined;

    act(() => {
      sharingButtonProps?.onPress?.();
    });

    const shareAllText = renderer!.root.findByProps({ children: "Share all" });
    let shareAllButton = shareAllText.parent;
    while (shareAllButton && (shareAllButton.type as unknown) !== "pressable") {
      shareAllButton = shareAllButton.parent;
    }

    const shareAllButtonProps = shareAllButton?.props as { onPress?: () => void } | undefined;

    act(() => {
      shareAllButtonProps?.onPress?.();
    });

    expect(savedRecipesState.setShareMode).toHaveBeenCalledWith("all");
  });

  it("opens a sort menu and persists the selected option", async () => {
    savedRecipesState.savedRecipes = [savedRecipe];

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<CookbookScreen />);
      await Promise.resolve();
    });

    const getSortControl = () =>
      renderer!.root.findByProps({
        accessibilityRole: "button",
        accessibilityHint: "Opens sorting options"
      });

    expect(getSortControl().props.accessibilityLabel).toBe("Sort recipes. Current: Recent");

    act(() => {
      (getSortControl().props as { onPress: () => void }).onPress();
    });
    const sortMenu = renderer!.root.findByProps({ testID: "cookbook-sort-menu" });
    expect(sortMenu.props.style).toMatchObject({ position: "absolute", right: 0, top: 56 });
    expect(renderer!.root.findAllByProps({ accessibilityLabel: "Sort by Oldest" })).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ accessibilityLabel: "Sort by Most cooked" }).length
    ).toBeGreaterThan(0);

    act(() => {
      (
        renderer!.root.findByProps({ accessibilityLabel: "Sort by A–Z" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    expect(getSortControl().props.accessibilityLabel).toBe("Sort recipes. Current: A–Z");
    expect(renderer!.root.findAllByProps({ testID: "cookbook-sort-menu" })).toHaveLength(0);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith("linkdish.cookbook.sort.v1", "az");

    const getDirectionControl = () =>
      renderer!.root.findByProps({ accessibilityHint: "Reverses the displayed recipe order" });
    expect(getDirectionControl().props.accessibilityLabel).toBe("Order: A to Z");

    act(() => {
      (getDirectionControl().props as { onPress: () => void }).onPress();
    });

    expect(getDirectionControl().props.accessibilityLabel).toBe("Order: Z to A");
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.cookbook.sort-direction.v1",
      "reverse"
    );
    expect(hapticMocks.selectionTick).toHaveBeenCalledTimes(3);
  });

  it("sorts personal recipes by most and least cooked", async () => {
    const oftenCookedRecipe = {
      ...savedRecipe,
      id: "saved_often",
      recipe: {
        ...savedRecipe.recipe,
        sourceUrl: "https://example.com/often",
        title: "Often Cooked"
      },
      savedAt: "2026-07-01T00:00:00.000Z",
      timesCooked: 5
    };
    const neverCookedRecipe = {
      ...savedRecipe,
      id: "saved_never",
      recipe: {
        ...savedRecipe.recipe,
        sourceUrl: "https://example.com/never",
        title: "Never Cooked"
      },
      savedAt: "2026-07-04T00:00:00.000Z",
      timesCooked: 0
    };
    savedRecipesState.savedRecipes = [neverCookedRecipe, oftenCookedRecipe];

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<CookbookScreen />);
      await Promise.resolve();
    });

    act(() => {
      (
        renderer!.root.findByProps({ accessibilityHint: "Opens sorting options" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    act(() => {
      (
        renderer!.root.findByProps({ accessibilityLabel: "Sort by Most cooked" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    let output = JSON.stringify(renderer!.toJSON());
    expect(output.indexOf("Often Cooked")).toBeLessThan(output.indexOf("Never Cooked"));
    const getDirectionControl = () =>
      renderer!.root.findByProps({ accessibilityHint: "Reverses the displayed recipe order" });
    expect(getDirectionControl().props.accessibilityLabel).toBe("Order: Most cooked first");

    act(() => {
      (getDirectionControl().props as { onPress: () => void }).onPress();
    });

    output = JSON.stringify(renderer!.toJSON());
    expect(output.indexOf("Never Cooked")).toBeLessThan(output.indexOf("Often Cooked"));
    expect(getDirectionControl().props.accessibilityLabel).toBe("Order: Least cooked first");
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.cookbook.sort.v1",
      "mostCooked"
    );
  });

  it("restores the last selected sort option and direction", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === "linkdish.cookbook.sort.v1" ? "az" : "reverse")
    );

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<CookbookScreen />);
      await Promise.resolve();
    });

    expect(
      renderer!.root.findByProps({ accessibilityHint: "Opens sorting options" }).props
        .accessibilityLabel
    ).toBe("Sort recipes. Current: A–Z");
    expect(
      renderer!.root.findByProps({ accessibilityHint: "Reverses the displayed recipe order" }).props
        .accessibilityLabel
    ).toBe("Order: Z to A");
  });

  it("migrates the old Oldest option to Recent with reversed order", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === "linkdish.cookbook.sort.v1" ? "oldest" : null)
    );

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<CookbookScreen />);
      await Promise.resolve();
    });

    expect(
      renderer!.root.findByProps({ accessibilityHint: "Opens sorting options" }).props
        .accessibilityLabel
    ).toBe("Sort recipes. Current: Recent");
    expect(
      renderer!.root.findByProps({ accessibilityHint: "Reverses the displayed recipe order" }).props
        .accessibilityLabel
    ).toBe("Order: Oldest first");
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.cookbook.sort-direction.v1",
      "reverse"
    );
  });

  it("keeps explicit breathing room between the tabs and utility row", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const utilityRow = renderer!.root.findByProps({ testID: "cookbook-search-sort-row" });

    expect(utilityRow.props.style).toMatchObject({ marginTop: 24 });
  });

  it("renders list-row recipe meta without the redundant source prefix", () => {
    savedRecipesState.savedRecipes = [savedRecipe];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const output = JSON.stringify(renderer!.toJSON());
    // Rows show the clean servings label and the total time (formatServings + getRecipeTimes).
    expect(output).toContain("Serves 4 · 30 min");
    expect(output).not.toContain("Webpage · 4 servings");
  });

  it("shows an inline hint when the locked Family segment is tapped", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const lockIcon = renderer!.root.findByProps({ name: "lock-outline" });
    let familyButton = lockIcon.parent;
    while (familyButton && (familyButton.type as unknown) !== "pressable") {
      familyButton = familyButton.parent;
    }

    const familyButtonProps = familyButton?.props as { onPress?: () => void } | undefined;

    act(() => {
      familyButtonProps?.onPress?.();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Sign in from the Household tab to share a Family cookbook."
    );
    expect(hapticMocks.warn).toHaveBeenCalled();
  });

  it("opens the save-limit upgrade sheet when duplicating into a full free Cookbook", () => {
    savedRecipesState.savedRecipes = [savedRecipe];
    savedRecipesState.cloneRecipe.mockReturnValue({
      allowed: false,
      message: "Your free Cookbook holds up to 15 personal recipes. Upgrade for unlimited saves.",
      reason: "save_limit_reached",
      saved: false
    });

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const duplicateButton = renderer!.root.findByProps({
      accessibilityLabel: "Duplicate recipe"
    });

    act(() => {
      (duplicateButton.props as { onPress: () => void }).onPress();
    });

    expect(upgradeMomentMocks.showUpgradeMoment).toHaveBeenCalledWith("save_limit");
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it("opens the upgrade moment from the typed save-limit reason, not the copy", () => {
    savedRecipesState.savedRecipes = [savedRecipe];
    savedRecipesState.cloneRecipe.mockReturnValue({
      allowed: false,
      message: "Reworded upgrade copy that no longer starts with the old prefix.",
      reason: "save_limit_reached",
      saved: false
    });

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const duplicateButton = renderer!.root.findByProps({
      accessibilityLabel: "Duplicate recipe"
    });

    act(() => {
      (duplicateButton.props as { onPress: () => void }).onPress();
    });

    expect(savedRecipesState.cloneRecipe).toHaveBeenCalledWith("saved_1");
    expect(upgradeMomentMocks.showUpgradeMoment).toHaveBeenCalledWith("save_limit");
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it("does not show the upgrade moment for unrelated duplicate failures", () => {
    savedRecipesState.savedRecipes = [savedRecipe];
    savedRecipesState.cloneRecipe.mockReturnValue({
      allowed: false,
      message: "This saved recipe is no longer available.",
      saved: false
    });

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    act(() => {
      (
        renderer!.root.findByProps({ accessibilityLabel: "Duplicate recipe" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    expect(upgradeMomentMocks.showUpgradeMoment).not.toHaveBeenCalled();
  });

  it("hides decorative recipe thumbnails from screen readers", () => {
    recipeImageMocks.buildProxiedRecipeImageUrl.mockReturnValue("https://example.com/thumb.jpg");
    savedRecipesState.savedRecipes = [savedRecipe];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const thumbnail = renderer!.root.findByType("Image" as never);

    expect((thumbnail.props as { accessible?: boolean }).accessible).toBe(false);
  });

  it("tells signed-in users without a household to join one instead of signing in", () => {
    accountState.isSignedIn = true;

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const lockIcon = renderer!.root.findByProps({ name: "lock-outline" });
    let familyButton = lockIcon.parent;
    while (familyButton && (familyButton.type as unknown) !== "pressable") {
      familyButton = familyButton.parent;
    }

    act(() => {
      (familyButton?.props as { onPress?: () => void } | undefined)?.onPress?.();
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain(
      "Join or create a household from the Household tab to share a Family cookbook."
    );
    expect(output).not.toContain("Sign in from the Household tab");
  });

  it("hearts a recipe from its row", () => {
    savedRecipesState.savedRecipes = [savedRecipe, { ...savedRecipe, favorite: true, id: "fav" }];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    act(() => {
      (
        renderer!.root.findByProps({ accessibilityLabel: "Add to favorites" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });
    act(() => {
      (
        renderer!.root.findByProps({ accessibilityLabel: "Remove from favorites" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    expect(savedRecipesState.setRecipeFavorite.mock.calls).toEqual([
      ["saved_1", true],
      ["fav", false]
    ]);
  });

  it("filters the Cookbook down to favorites", () => {
    savedRecipesState.savedRecipes = [
      savedRecipe,
      {
        ...savedRecipe,
        favorite: true,
        id: "fav",
        recipe: { ...savedRecipe.recipe, sourceUrl: "https://example.com/fav", title: "Loved Pie" }
      }
    ];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const favoritesFilter = () =>
      renderer!.root.findByProps({ testID: "cookbook-favorites-filter" });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Favorites · 1");

    act(() => {
      (favoritesFilter().props as { onPress: () => void }).onPress();
    });

    let output = JSON.stringify(renderer!.toJSON());
    expect(favoritesFilter().props.accessibilityState).toEqual({ selected: true });
    expect(output).toContain("Loved Pie");
    expect(output).not.toContain("Tomato Toast");

    savedRecipesState.savedRecipes = [savedRecipe];

    act(() => {
      renderer!.update(<CookbookScreen />);
    });

    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("No favorites yet. Tap the heart on a recipe to keep it here.");
  });

  it("sorts by the quickest recipes and keeps untimed ones last", async () => {
    savedRecipesState.savedRecipes = [
      {
        ...savedRecipe,
        id: "slow",
        recipe: {
          ...savedRecipe.recipe,
          cookTimeMinutes: 180,
          sourceUrl: "https://example.com/slow",
          title: "Slow Stew"
        }
      },
      {
        ...savedRecipe,
        id: "untimed",
        recipe: {
          ...savedRecipe.recipe,
          cookTimeMinutes: null,
          prepTimeMinutes: null,
          sourceUrl: "https://example.com/untimed",
          title: "Mystery Dish"
        }
      },
      {
        ...savedRecipe,
        id: "fast",
        recipe: {
          ...savedRecipe.recipe,
          cookTimeMinutes: 5,
          prepTimeMinutes: 5,
          sourceUrl: "https://example.com/fast",
          title: "Fast Toast"
        }
      }
    ];

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<CookbookScreen />);
      await Promise.resolve();
    });

    act(() => {
      (
        renderer!.root.findByProps({ accessibilityHint: "Opens sorting options" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });
    act(() => {
      (
        renderer!.root.findByProps({ accessibilityLabel: "Sort by Quickest" }).props as {
          onPress: () => void;
        }
      ).onPress();
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output.indexOf("Fast Toast")).toBeLessThan(output.indexOf("Slow Stew"));
    expect(output.indexOf("Slow Stew")).toBeLessThan(output.indexOf("Mystery Dish"));
    expect(output).toContain("Serves 4 · 3 hr");
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith("linkdish.cookbook.sort.v1", "quickest");
  });

  it("renders rows in a virtualized list with a pinned controls row", () => {
    savedRecipesState.savedRecipes = [savedRecipe];

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const list = renderer!.root.findByType("flat-list" as never);
    const listProps = list.props as { initialNumToRender?: number; stickyHeaderIndices?: number[] };

    expect(listProps.stickyHeaderIndices).toEqual([1]);
    expect(listProps.initialNumToRender).toBeGreaterThan(0);
  });

  it("animates only the first rows of the first populated render", () => {
    savedRecipesState.savedRecipes = Array.from({ length: 10 }, (_, index) => ({
      ...savedRecipe,
      id: `saved_${index}`,
      recipe: {
        ...savedRecipe.recipe,
        sourceUrl: `https://example.com/${index}`,
        title: `Recipe ${index}`
      }
    }));

    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<CookbookScreen />);
    });

    const animatedRows = () =>
      renderer!.root
        .findAllByType("animated-view" as never)
        .map((node) => (node.props as { mountEntering?: unknown }).mountEntering);

    const firstMount = animatedRows();
    expect(firstMount.filter(Boolean)).toHaveLength(8);
    expect(firstMount[0]).toEqual({ delay: 0, reduceMotion: "system" });
    expect(firstMount.slice(8).filter(Boolean)).toHaveLength(0);

    savedRecipesState.savedRecipes = [
      {
        ...savedRecipe,
        id: "new",
        recipe: { ...savedRecipe.recipe, sourceUrl: "https://example.com/new", title: "New" }
      },
      ...(savedRecipesState.savedRecipes as Array<typeof savedRecipe>)
    ];

    act(() => {
      renderer!.update(<CookbookScreen />);
    });

    // The row added later mounts without motion; existing rows were not remounted.
    const afterUpdate = animatedRows();
    expect(afterUpdate).toHaveLength(11);
    expect(afterUpdate[0]).toBeUndefined();
    expect(afterUpdate.filter(Boolean)).toHaveLength(8);
  });
});
