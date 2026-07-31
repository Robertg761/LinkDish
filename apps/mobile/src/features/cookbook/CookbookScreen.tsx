import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppText } from "@linkdish/ui";
import { decodeHtmlEntities } from "@linkdish/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle
} from "react-native";
import Reanimated, {
  Easing as ReanimatedEasing,
  FadeInDown,
  ReduceMotion
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppDialog } from "../../components/AppDialog";
import { selectionTick, warn as warnHaptic } from "../../lib/haptics";
import { buildProxiedRecipeImageUrl, getRecipeMonogram } from "../../lib/recipeImage";
import { EMPTY_LIBRARY_LINES, selectFlavorCopyLine } from "../../theme/flavorCopy";
import { pressedOpacity, pressedScale } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import { useAccount } from "../account/AccountContext";
import { useOptionalUpgradeMoment } from "../billing/UpgradeMomentContext";
import { buildRecipeMetaLine } from "../recipe-results/recipeMetaLine";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";
import {
  getSharedRecipeOwnerLabel,
  searchSavedRecipeRecords,
  searchSharedRecipeRecords,
  type SavedRecipeRecord
} from "../saved-recipes/store";

import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";
import type { ComponentProps } from "react";

type CookbookTab = "personal" | "family";
type CookbookSort = "recent" | "az" | "mostCooked";
type CookbookSortDirection = "forward" | "reverse";
type PendingConfirmation = {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  onConfirm: () => void;
  title: string;
};

const ROW_ENTER_DURATION_MS = 220;
const ROW_STAGGER_MS = 18;
const ROW_STAGGER_CAP = 8;
const COOKBOOK_SORT_STORAGE_KEY = "linkdish.cookbook.sort.v1";
const COOKBOOK_SORT_DIRECTION_STORAGE_KEY = "linkdish.cookbook.sort-direction.v1";
const COOKBOOK_SORT_OPTIONS: Array<{ label: string; value: CookbookSort }> = [
  { label: "Recent", value: "recent" },
  { label: "A–Z", value: "az" },
  { label: "Most cooked", value: "mostCooked" }
];

const isCookbookSort = (value: string | null): value is CookbookSort =>
  COOKBOOK_SORT_OPTIONS.some((option) => option.value === value);

const isCookbookSortDirection = (value: string | null): value is CookbookSortDirection =>
  value === "forward" || value === "reverse";

const getRowEntering = (index: number) =>
  FadeInDown.duration(ROW_ENTER_DURATION_MS)
    .delay(Math.min(index, ROW_STAGGER_CAP) * ROW_STAGGER_MS)
    .easing(ReanimatedEasing.out(ReanimatedEasing.cubic))
    .reduceMotion(ReduceMotion.System);

const normalizeRecipeText = (value: string) => decodeHtmlEntities(value).replace(/\u00a0/gu, " ");

const sortByTitle = <T extends { recipe: Pick<Recipe, "title"> }>(
  records: T[],
  direction: CookbookSortDirection
) => {
  const sortedRecords = [...records].sort((left, right) =>
    normalizeRecipeText(left.recipe.title).localeCompare(normalizeRecipeText(right.recipe.title))
  );

  return direction === "reverse" ? sortedRecords.reverse() : sortedRecords;
};

const sortSavedRecipes = (
  records: SavedRecipeRecord[],
  sort: CookbookSort,
  direction: CookbookSortDirection
) => {
  if (sort === "az") {
    return sortByTitle(records, direction);
  }

  if (sort === "mostCooked") {
    const sortedRecords = [...records].sort(
      (left, right) =>
        (right.timesCooked ?? 0) - (left.timesCooked ?? 0) ||
        Date.parse(right.savedAt) - Date.parse(left.savedAt)
    );

    return direction === "reverse" ? sortedRecords.reverse() : sortedRecords;
  }

  const sortedRecords = [...records].sort(
    (left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt)
  );

  return direction === "reverse" ? sortedRecords.reverse() : sortedRecords;
};

const sortSharedRecipes = (
  records: SharedRecipe[],
  sort: CookbookSort,
  direction: CookbookSortDirection
) => {
  if (sort === "az") {
    return sortByTitle(records, direction);
  }

  const sortedRecords = [...records].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  );

  return direction === "reverse" ? sortedRecords.reverse() : sortedRecords;
};

const getSortDirectionLabel = (sort: CookbookSort, direction: CookbookSortDirection) => {
  if (sort === "az") {
    return direction === "forward" ? "A to Z" : "Z to A";
  }

  if (sort === "mostCooked") {
    return direction === "forward" ? "Most cooked first" : "Least cooked first";
  }

  return direction === "forward" ? "Newest first" : "Oldest first";
};

const RecipeBookThumbnail = ({ recipe }: { recipe: Pick<Recipe, "image" | "title"> }) => {
  const imageUrl = buildProxiedRecipeImageUrl(recipe.image, 96);

  return (
    <View style={styles.recipeThumbnail}>
      {imageUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{ uri: imageUrl }}
          style={styles.recipeThumbnailImage}
        />
      ) : (
        <AppText italic style={styles.recipeThumbnailMonogram}>
          {getRecipeMonogram(recipe.title)}
        </AppText>
      )}
    </View>
  );
};

const SegmentButton = ({
  active,
  disabled = false,
  label,
  locked = false,
  onPress,
  style
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  locked?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      styles.segmentButton,
      style,
      active && styles.segmentButtonActive,
      disabled && styles.segmentButtonDisabled,
      pressed && !disabled && styles.pressed
    ]}
  >
    <AppText style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>
      {locked ? (
        <MaterialCommunityIcons
          color={appColors.muted}
          name="lock-outline"
          size={12}
          style={styles.segmentLockIcon}
        />
      ) : null}
      {label}
    </AppText>
  </Pressable>
);

const IconAction = ({
  accessibilityLabel,
  color = appColors.muted,
  disabled = false,
  name,
  onPress
}: {
  accessibilityLabel: string;
  color?: string;
  disabled?: boolean;
  name: ComponentProps<typeof MaterialCommunityIcons>["name"];
  onPress: () => void;
}) => (
  <Pressable
    accessibilityLabel={accessibilityLabel}
    accessibilityRole="button"
    disabled={disabled}
    hitSlop={10}
    onPress={onPress}
    style={({ pressed }) => [
      styles.recipeIconAction,
      disabled && styles.disabledAction,
      pressed && !disabled && styles.pressed
    ]}
  >
    <MaterialCommunityIcons color={color} name={name} size={18} />
  </Pressable>
);

export const CookbookScreen = () => {
  const pathname = usePathname();
  const routeParams = useLocalSearchParams<{ savedId?: string; sharedId?: string }>();
  const { user } = useAccount();
  const {
    canUseSharedRecipeBook,
    cloneRecipe,
    cloneSharedRecipe,
    deleteSharedRecipe,
    hasLoadedSavedRecipes,
    hasLoadedSharedRecipes,
    removeRecipe,
    savedRecipes,
    setShareMode,
    sharedRecipeError,
    sharedRecipes,
    shareMode,
    shareRecipe,
    unshareRecipe
  } = useSavedRecipes();
  const { showUpgradeMoment } = useOptionalUpgradeMoment();
  const insets = useSafeAreaInsets();
  const searchInputRef = useRef<TextInput>(null);
  const lockedFamilyHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortPreferencesChangedRef = useRef(false);
  const [activeTab, setActiveTab] = useState<CookbookTab>("personal");
  const [query, setQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [sort, setSort] = useState<CookbookSort>("recent");
  const [sortDirection, setSortDirection] = useState<CookbookSortDirection>("forward");
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [isFamilySharingOpen, setIsFamilySharingOpen] = useState(false);
  const [lockedFamilyHintVisible, setLockedFamilyHintVisible] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const emptyLibraryLine = useMemo(() => selectFlavorCopyLine(EMPTY_LIBRARY_LINES), []);
  const activeSort = activeTab === "family" && sort === "mostCooked" ? "recent" : sort;
  const filteredSavedRecipes = useMemo(
    () => sortSavedRecipes(searchSavedRecipeRecords(savedRecipes, query), sort, sortDirection),
    [query, savedRecipes, sort, sortDirection]
  );
  const filteredSharedRecipes = useMemo(
    () =>
      sortSharedRecipes(searchSharedRecipeRecords(sharedRecipes, query), activeSort, sortDirection),
    [activeSort, query, sharedRecipes, sortDirection]
  );
  const activeSortOption =
    COOKBOOK_SORT_OPTIONS.find((option) => option.value === activeSort) ??
    COOKBOOK_SORT_OPTIONS[0]!;
  const sortDirectionLabel = getSortDirectionLabel(activeSort, sortDirection);

  const toggleSortMenu = () => {
    selectionTick();
    dismissLockedFamilyHint();
    setIsSortMenuOpen((current) => !current);
  };

  const selectSort = (nextSort: CookbookSort) => {
    sortPreferencesChangedRef.current = true;
    selectionTick();
    setSort(nextSort);
    setIsSortMenuOpen(false);
    void AsyncStorage.setItem(COOKBOOK_SORT_STORAGE_KEY, nextSort).catch(() => undefined);
  };

  const toggleSortDirection = () => {
    sortPreferencesChangedRef.current = true;
    selectionTick();
    setSortDirection((currentDirection) => {
      const nextDirection = currentDirection === "forward" ? "reverse" : "forward";
      void AsyncStorage.setItem(COOKBOOK_SORT_DIRECTION_STORAGE_KEY, nextDirection).catch(
        () => undefined
      );
      return nextDirection;
    });
  };

  const openImport = () => {
    router.push("/import" as never);
  };

  const clearLockedFamilyHintTimer = () => {
    if (lockedFamilyHintTimeoutRef.current) {
      clearTimeout(lockedFamilyHintTimeoutRef.current);
      lockedFamilyHintTimeoutRef.current = null;
    }
  };

  const dismissLockedFamilyHint = () => {
    clearLockedFamilyHintTimer();
    setLockedFamilyHintVisible(false);
  };

  const showLockedFamilyHint = () => {
    warnHaptic();
    clearLockedFamilyHintTimer();
    setLockedFamilyHintVisible(true);
    lockedFamilyHintTimeoutRef.current = setTimeout(() => {
      setLockedFamilyHintVisible(false);
      lockedFamilyHintTimeoutRef.current = null;
    }, 4000);
  };

  useEffect(() => () => clearLockedFamilyHintTimer(), []);

  useEffect(() => {
    let isActive = true;

    void Promise.all([
      AsyncStorage.getItem(COOKBOOK_SORT_STORAGE_KEY),
      AsyncStorage.getItem(COOKBOOK_SORT_DIRECTION_STORAGE_KEY)
    ])
      .then(([storedSort, storedDirection]) => {
        if (!isActive || sortPreferencesChangedRef.current) {
          return;
        }

        if (storedSort === "oldest") {
          setSort("recent");
          setSortDirection("reverse");
          void Promise.all([
            AsyncStorage.setItem(COOKBOOK_SORT_STORAGE_KEY, "recent"),
            AsyncStorage.setItem(COOKBOOK_SORT_DIRECTION_STORAGE_KEY, "reverse")
          ]).catch(() => undefined);
          return;
        }

        if (isCookbookSort(storedSort)) {
          setSort(storedSort);
        }

        if (isCookbookSortDirection(storedDirection)) {
          setSortDirection(storedDirection);
        }
      })
      .catch(() => undefined);

    return () => {
      isActive = false;
    };
  }, []);

  const openSavedRecipe = (id: string) => {
    if (pathname === "/recipe") {
      router.replace({ pathname: "/recipe", params: { savedId: id } });
      return;
    }

    router.push({ pathname: "/recipe", params: { savedId: id } });
  };

  const openSharedRecipe = (id: string) => {
    if (pathname === "/recipe") {
      router.replace({ pathname: "/recipe", params: { sharedId: id } });
      return;
    }

    router.push({ pathname: "/recipe", params: { sharedId: id } });
  };

  const duplicateSavedRecipe = (id: string) => {
    const result = cloneRecipe(id);

    if (!result.saved || !result.recipeId) {
      if (!result.allowed && result.message?.startsWith("Your free Cookbook holds")) {
        showUpgradeMoment("save_limit");
      }

      return;
    }

    router.push({
      pathname: "/recipe",
      params: {
        edit: "1",
        savedId: result.recipeId
      }
    });
  };

  const duplicateSharedRecipe = (id: string) => {
    const result = cloneSharedRecipe(id);

    if (!result.saved || !result.recipeId) {
      if (!result.allowed && result.message?.startsWith("Your free Cookbook holds")) {
        showUpgradeMoment("save_limit");
      }

      return;
    }

    router.push({
      pathname: "/recipe",
      params: {
        edit: "1",
        savedId: result.recipeId
      }
    });
  };

  const removeSavedRecipe = (id: string, title: string) => {
    setPendingConfirmation({
      cancelLabel: "Cancel",
      confirmLabel: "Remove",
      message: `\u201c${title}\u201d will be removed from your cookbook.`,
      onConfirm: () => {
        warnHaptic();
        removeRecipe(id);

        if (pathname === "/recipe" && routeParams.savedId === id) {
          router.replace("/");
        }
      },
      title: "Remove recipe?"
    });
  };

  const toggleRecipeShared = (id: string, isShared: boolean) => {
    if (!isShared) {
      void shareRecipe(id);
      return;
    }

    setPendingConfirmation({
      cancelLabel: "Keep shared",
      confirmLabel: "Unshare",
      message: "Remove this recipe from the Family recipe book?",
      onConfirm: () => {
        void unshareRecipe(id);
      },
      title: "Unshare recipe?"
    });
  };

  const removeSharedRecipe = (id: string, title: string) => {
    setPendingConfirmation({
      cancelLabel: "Keep shared",
      confirmLabel: "Unshare",
      message: `Remove "${title}" from the Family recipe book?`,
      onConfirm: () => {
        void deleteSharedRecipe(id).then((result) => {
          if (result.saved && pathname === "/recipe" && routeParams.sharedId === id) {
            router.replace("/");
          }
        });
      },
      title: "Unshare recipe?"
    });
  };

  const renderEmptyState = (message: string, ctaLabel = "Import a recipe") => (
    <View style={styles.emptyState}>
      <View style={styles.emptyStateIcon}>
        <MaterialCommunityIcons color={appColors.accent} name="book-open-variant" size={26} />
      </View>
      <AppText muted style={styles.emptyStateText}>
        {message}
      </AppText>
      <AppButton label={ctaLabel} onPress={openImport} style={styles.emptyStateButton} />
    </View>
  );

  const renderSavedRecipes = () => {
    if (!hasLoadedSavedRecipes) {
      return (
        <View style={styles.listMessage}>
          <AppText muted>Loading your saved recipes...</AppText>
        </View>
      );
    }

    if (savedRecipes.length === 0) {
      return renderEmptyState(emptyLibraryLine);
    }

    if (filteredSavedRecipes.length === 0) {
      return (
        <View style={styles.listMessage}>
          <AppText muted>No saved recipes match this search.</AppText>
        </View>
      );
    }

    return filteredSavedRecipes.map((entry, index) => (
      <Reanimated.View entering={getRowEntering(index)} key={entry.id} style={styles.recipeRow}>
        <Pressable
          onPress={() => openSavedRecipe(entry.id)}
          style={({ pressed }) => [styles.recipePressable, pressed && styles.rowPressed]}
        >
          <RecipeBookThumbnail recipe={entry.recipe} />
          <View style={styles.recipeContent}>
            <View style={styles.recipeTitleRow}>
              <AppText numberOfLines={2} style={styles.recipeTitle} variant="title">
                {normalizeRecipeText(entry.recipe.title)}
              </AppText>
            </View>
            <AppText muted numberOfLines={2} style={styles.recipeMeta}>
              {buildRecipeMetaLine(entry.recipe, { includeSourceType: false })}
            </AppText>
            {entry.notes ? (
              <AppText muted numberOfLines={1} style={styles.recipeMeta}>
                {normalizeRecipeText(entry.notes)}
              </AppText>
            ) : null}
            {entry.isStarter ? (
              <View style={styles.starterChip}>
                <AppText style={styles.starterChipText}>Starter recipe</AppText>
              </View>
            ) : null}
          </View>
        </Pressable>

        <View
          style={[
            styles.recipeActions,
            canUseSharedRecipeBook && !entry.isStarter && styles.recipeActionsWide
          ]}
        >
          <MaterialCommunityIcons color={appColors.accent} name="chevron-right" size={18} />
          <IconAction
            accessibilityLabel="Duplicate recipe"
            color={appColors.accent}
            disabled={!hasLoadedSavedRecipes}
            name="content-copy"
            onPress={() => duplicateSavedRecipe(entry.id)}
          />
          <IconAction
            accessibilityLabel="Remove recipe"
            name="bookmark-remove-outline"
            onPress={() => removeSavedRecipe(entry.id, entry.recipe.title)}
          />
          {canUseSharedRecipeBook && !entry.isStarter ? (
            <IconAction
              accessibilityLabel={entry.sharedRecipeId ? "Unshare recipe" : "Share recipe"}
              name={
                entry.sharedRecipeId
                  ? "account-multiple-minus-outline"
                  : "account-multiple-plus-outline"
              }
              onPress={() => toggleRecipeShared(entry.id, entry.sharedRecipeId != null)}
            />
          ) : null}
        </View>
      </Reanimated.View>
    ));
  };

  const renderSharedRecipes = () => {
    if (!hasLoadedSharedRecipes) {
      return (
        <View style={styles.listMessage}>
          <AppText muted>Loading shared family recipes...</AppText>
        </View>
      );
    }

    if (sharedRecipes.length === 0) {
      return renderEmptyState(emptyLibraryLine);
    }

    if (filteredSharedRecipes.length === 0) {
      return (
        <View style={styles.listMessage}>
          <AppText muted>No shared recipes match this search.</AppText>
        </View>
      );
    }

    return filteredSharedRecipes.map((entry, index) => {
      const isOwnedByCurrentUser = entry.ownerUserId === user?.id;

      return (
        <Reanimated.View entering={getRowEntering(index)} key={entry.id} style={styles.recipeRow}>
          <Pressable
            onPress={() => openSharedRecipe(entry.id)}
            style={({ pressed }) => [styles.recipePressable, pressed && styles.rowPressed]}
          >
            <RecipeBookThumbnail recipe={entry.recipe} />
            <View style={styles.recipeContent}>
              <View style={styles.recipeTitleRow}>
                <AppText numberOfLines={2} style={styles.recipeTitle} variant="title">
                  {normalizeRecipeText(entry.recipe.title)}
                </AppText>
              </View>
              <AppText muted numberOfLines={2} style={styles.recipeMeta}>
                {buildRecipeMetaLine(entry.recipe, { includeSourceType: false })}
              </AppText>
              <AppText muted numberOfLines={1} style={styles.recipeMeta}>
                Owned by {getSharedRecipeOwnerLabel(entry)}
              </AppText>
            </View>
          </Pressable>

          <View style={[styles.recipeActions, isOwnedByCurrentUser && styles.recipeActionsWide]}>
            <MaterialCommunityIcons color={appColors.accent} name="chevron-right" size={18} />
            <IconAction
              accessibilityLabel="Save copy"
              color={appColors.accent}
              disabled={!hasLoadedSavedRecipes}
              name="content-copy"
              onPress={() => duplicateSharedRecipe(entry.id)}
            />
            {isOwnedByCurrentUser ? (
              <IconAction
                accessibilityLabel="Unshare recipe"
                name="account-multiple-minus-outline"
                onPress={() => removeSharedRecipe(entry.id, entry.recipe.title)}
              />
            ) : null}
          </View>
        </Reanimated.View>
      );
    });
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.container,
          {
            paddingBottom: Math.max(insets.bottom, appSpacing.xl) + 96,
            paddingTop: Math.max(insets.top, appSpacing.lg) + appSpacing.lg
          }
        ]}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[1]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.header, styles.wideSection]}>
          <AppText style={styles.title} variant="display">
            Cookbook
          </AppText>
        </View>

        <View style={[styles.pinnedControls, styles.wideSection]}>
          <View style={styles.tabGroup}>
            <View style={styles.tabRow}>
              <SegmentButton
                active={activeTab === "personal"}
                label="Personal"
                onPress={() => {
                  dismissLockedFamilyHint();
                  setActiveTab("personal");
                }}
              />
              <SegmentButton
                active={activeTab === "family"}
                locked={
                  hasLoadedSharedRecipes && !canUseSharedRecipeBook && sharedRecipes.length === 0
                }
                label="Family"
                onPress={() => {
                  if (
                    hasLoadedSharedRecipes &&
                    !canUseSharedRecipeBook &&
                    sharedRecipes.length === 0
                  ) {
                    showLockedFamilyHint();
                    return;
                  }

                  dismissLockedFamilyHint();
                  setActiveTab("family");
                }}
                style={
                  hasLoadedSharedRecipes && !canUseSharedRecipeBook && sharedRecipes.length === 0
                    ? styles.segmentButtonDisabled
                    : undefined
                }
              />
            </View>

            {lockedFamilyHintVisible ? (
              <AppText muted style={styles.lockedFamilyHint}>
                Sign in from the Household tab to share a Family cookbook.
              </AppText>
            ) : null}
          </View>

          <View style={styles.searchSortRow} testID="cookbook-search-sort-row">
            <Pressable
              onPress={() => searchInputRef.current?.focus()}
              style={[styles.search, isSearchFocused && styles.searchFocused]}
            >
              <MaterialCommunityIcons
                color={isSearchFocused ? appColors.accent : appColors.muted}
                name="magnify"
                size={18}
              />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onBlur={() => setIsSearchFocused(false)}
                onChangeText={setQuery}
                onFocus={() => {
                  dismissLockedFamilyHint();
                  setIsSearchFocused(true);
                }}
                placeholder={
                  activeTab === "family" ? "Search family recipes" : "Search personal recipes"
                }
                placeholderTextColor={appColors.placeholder}
                ref={searchInputRef}
                style={styles.searchInput}
                value={query}
              />
            </Pressable>

            <View style={styles.sortControls}>
              <View style={styles.sortControlGroup}>
                <Pressable
                  accessibilityHint="Opens sorting options"
                  accessibilityLabel={`Sort recipes. Current: ${activeSortOption.label}`}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isSortMenuOpen }}
                  onPress={toggleSortMenu}
                  style={({ pressed }) => [styles.sortControl, pressed && styles.rowPressed]}
                >
                  <AppText style={styles.sortValue}>{activeSortOption.label}</AppText>
                  <MaterialCommunityIcons
                    color={appColors.accent}
                    name={isSortMenuOpen ? "chevron-up" : "chevron-down"}
                    size={17}
                  />
                </Pressable>

                {isSortMenuOpen ? (
                  <View
                    accessibilityRole="menu"
                    style={styles.sortMenu}
                    testID="cookbook-sort-menu"
                  >
                    {COOKBOOK_SORT_OPTIONS.filter(
                      (option) => activeTab === "personal" || option.value !== "mostCooked"
                    ).map((option) => {
                      const isSelected = option.value === activeSort;

                      return (
                        <Pressable
                          accessibilityLabel={`Sort by ${option.label}`}
                          accessibilityRole="menuitem"
                          accessibilityState={{ selected: isSelected }}
                          key={option.value}
                          onPress={() => selectSort(option.value)}
                          style={({ pressed }) => [
                            styles.sortMenuOption,
                            isSelected && styles.sortMenuOptionSelected,
                            pressed && styles.rowPressed
                          ]}
                        >
                          <AppText
                            style={[
                              styles.sortMenuOptionText,
                              isSelected && styles.sortMenuOptionActive
                            ]}
                          >
                            {option.label}
                          </AppText>
                          {isSelected ? (
                            <MaterialCommunityIcons
                              color={appColors.accent}
                              name="check"
                              size={18}
                            />
                          ) : (
                            <View style={styles.sortMenuCheckSpacer} />
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>

              <Pressable
                accessibilityHint="Reverses the displayed recipe order"
                accessibilityLabel={`Order: ${sortDirectionLabel}`}
                accessibilityRole="button"
                onPress={toggleSortDirection}
                style={({ pressed }) => [styles.sortDirectionControl, pressed && styles.rowPressed]}
              >
                <MaterialCommunityIcons
                  color={appColors.accent}
                  name={sortDirection === "forward" ? "arrow-down" : "arrow-up"}
                  size={20}
                />
              </Pressable>
            </View>
          </View>
        </View>

        <View style={[styles.content, styles.wideSection]}>
          {activeTab === "personal" && canUseSharedRecipeBook ? (
            <View style={styles.familySharing}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setIsFamilySharingOpen((current) => !current)}
                style={({ pressed }) => [styles.familySharingHeader, pressed && styles.rowPressed]}
              >
                <View style={styles.familySharingTitle}>
                  <MaterialCommunityIcons
                    color={appColors.accent}
                    name="account-multiple-outline"
                    size={18}
                  />
                  <AppText style={styles.familySharingLabel} variant="title">
                    Family sharing
                  </AppText>
                </View>
                <MaterialCommunityIcons
                  color={appColors.muted}
                  name={isFamilySharingOpen ? "chevron-up" : "chevron-down"}
                  size={20}
                />
              </Pressable>

              {isFamilySharingOpen ? (
                <View style={styles.shareModeRow}>
                  {(["none", "selected", "all"] as const).map((mode) => (
                    <Pressable
                      key={mode}
                      onPress={() => {
                        void setShareMode(mode);
                      }}
                      style={({ pressed }) => [
                        styles.shareModeButton,
                        shareMode === mode && styles.shareModeButtonActive,
                        pressed && styles.pressed
                      ]}
                    >
                      <AppText
                        style={[
                          styles.shareModeText,
                          shareMode === mode && styles.shareModeTextActive
                        ]}
                      >
                        {mode === "none" ? "Share none" : mode === "all" ? "Share all" : "Selected"}
                      </AppText>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {activeTab === "personal" && sharedRecipeError ? (
            <View style={styles.listMessage}>
              <AppText muted>{sharedRecipeError}</AppText>
            </View>
          ) : null}

          {activeTab === "personal" ? renderSavedRecipes() : renderSharedRecipes()}
        </View>
      </ScrollView>
      <AppDialog
        actions={
          pendingConfirmation
            ? [
                {
                  label: pendingConfirmation.cancelLabel,
                  onPress: () => setPendingConfirmation(null),
                  variant: "outline"
                },
                {
                  label: pendingConfirmation.confirmLabel,
                  onPress: () => {
                    const action = pendingConfirmation.onConfirm;
                    setPendingConfirmation(null);
                    action();
                  },
                  variant: "danger"
                }
              ]
            : []
        }
        message={pendingConfirmation?.message ?? ""}
        onRequestClose={() => setPendingConfirmation(null)}
        title={pendingConfirmation?.title ?? ""}
        visible={pendingConfirmation != null}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: appColors.background,
    flexGrow: 1
  },
  content: {
    paddingHorizontal: appSpacing.lg
  },
  disabledAction: {
    opacity: 0.45
  },
  emptyState: {
    alignItems: "center",
    gap: appSpacing.md,
    justifyContent: "center",
    minHeight: 260,
    paddingHorizontal: appSpacing.xl
  },
  emptyStateButton: {
    minWidth: 180
  },
  emptyStateIcon: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 58,
    justifyContent: "center",
    width: 58
  },
  emptyStateText: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  familySharing: {
    borderBottomColor: "rgba(221, 210, 195, 0.72)",
    borderBottomWidth: 1,
    gap: appSpacing.sm,
    marginBottom: appSpacing.sm,
    paddingBottom: appSpacing.md
  },
  familySharingHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 42
  },
  familySharingLabel: {
    fontSize: 16,
    lineHeight: 21
  },
  familySharingTitle: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm
  },
  header: {
    paddingHorizontal: appSpacing.lg,
    paddingBottom: appSpacing.lg
  },
  listMessage: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
    padding: appSpacing.lg
  },
  lockedFamilyHint: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: appSpacing.xs
  },
  pinnedControls: {
    backgroundColor: appColors.background,
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    paddingBottom: appSpacing.lg,
    paddingHorizontal: appSpacing.lg,
    paddingTop: appSpacing.xs,
    zIndex: 20
  },
  pressed: {
    opacity: pressedOpacity.soft,
    transform: [{ scale: pressedScale.standard }]
  },
  recipeActions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    width: 108
  },
  recipeActionsWide: {
    width: 142
  },
  recipeContent: {
    flex: 1,
    gap: 3,
    minWidth: 0
  },
  recipeIconAction: {
    alignItems: "center",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  recipeMeta: {
    fontSize: 13,
    lineHeight: 18
  },
  recipePressable: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: appSpacing.md,
    minWidth: 0
  },
  recipeRow: {
    alignItems: "center",
    borderBottomColor: "rgba(221, 210, 195, 0.72)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 11
  },
  recipeThumbnail: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 16,
    height: 56,
    justifyContent: "center",
    overflow: "hidden",
    width: 56
  },
  recipeThumbnailImage: {
    height: "100%",
    width: "100%"
  },
  recipeThumbnailMonogram: {
    color: appColors.accent,
    fontSize: 28,
    lineHeight: 34
  },
  recipeTitle: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21
  },
  recipeTitleRow: {
    alignItems: "center",
    columnGap: appSpacing.sm,
    flexDirection: "row"
  },
  rowPressed: {
    opacity: pressedOpacity.subtle,
    transform: [{ scale: pressedScale.standard }]
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  search: {
    alignItems: "center",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: appSpacing.sm,
    minHeight: 48,
    paddingHorizontal: appSpacing.md
  },
  searchFocused: {
    borderColor: appColors.accent,
    borderWidth: 1.5
  },
  searchInput: {
    color: appColors.text,
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    paddingVertical: 10
  },
  segmentButton: {
    alignItems: "center",
    borderRadius: 15,
    flex: 1,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: appSpacing.md
  },
  segmentButtonActive: {
    backgroundColor: appColors.surface
  },
  segmentButtonDisabled: {
    opacity: 0.45
  },
  segmentButtonText: {
    color: appColors.muted,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18
  },
  segmentButtonTextActive: {
    color: appColors.text
  },
  segmentLockIcon: {
    marginRight: 4
  },
  shareModeButton: {
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 10
  },
  shareModeButtonActive: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  shareModeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: appSpacing.sm
  },
  shareModeText: {
    color: appColors.muted,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 16
  },
  shareModeTextActive: {
    color: appColors.canvas
  },
  sortControl: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: appSpacing.xs,
    justifyContent: "center",
    minHeight: 48,
    minWidth: 96,
    paddingHorizontal: 10
  },
  sortControlGroup: {
    zIndex: 20
  },
  sortControls: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm,
    zIndex: 20
  },
  sortDirectionControl: {
    alignItems: "center",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: 48
  },
  sortMenu: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    elevation: 5,
    overflow: "hidden",
    padding: appSpacing.xs,
    position: "absolute",
    right: 0,
    shadowColor: "#000000",
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    top: 56,
    width: 156,
    zIndex: 20
  },
  sortMenuCheckSpacer: {
    width: 18
  },
  sortMenuOption: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: appSpacing.md
  },
  sortMenuOptionActive: {
    color: appColors.accent
  },
  sortMenuOptionSelected: {
    backgroundColor: appColors.accentSoft
  },
  sortMenuOptionText: {
    color: appColors.text,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18
  },
  sortValue: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18
  },
  searchSortRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: appSpacing.xxl
  },
  starterChip: {
    alignSelf: "flex-start",
    backgroundColor: appColors.accentSoft,
    borderColor: "rgba(180, 91, 40, 0.24)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3
  },
  starterChipText: {
    color: appColors.accent,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 14
  },
  tabRow: {
    backgroundColor: appColors.accentSoft,
    borderRadius: 19,
    flexDirection: "row",
    gap: appSpacing.xs,
    padding: appSpacing.xs
  },
  tabGroup: {
    gap: appSpacing.sm
  },
  title: {
    color: appColors.text,
    fontSize: 42,
    lineHeight: 50
  },
  wideSection: {
    alignSelf: "center",
    maxWidth: 900,
    width: "100%"
  }
});
