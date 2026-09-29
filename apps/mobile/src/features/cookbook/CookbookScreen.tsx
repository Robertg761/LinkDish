import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppText } from "@linkdish/ui";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import React, {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type ListRenderItem,
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
  buildSavedRecipeSearchIndex,
  buildSharedRecipeSearchIndex,
  getSharedRecipeOwnerLabel,
  type SavedRecipeRecord
} from "../saved-recipes/store";

import {
  COOKBOOK_SORT_OPTIONS,
  getSortDirectionLabel,
  isCookbookSort,
  isCookbookSortDirection,
  normalizeRecipeText,
  sortCookbookRecords,
  type CookbookSort,
  type CookbookSortDirection
} from "./cookbookSort";

import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";
import type { ComponentProps } from "react";

type CookbookTab = "personal" | "family";
type PendingConfirmation = {
  cancelLabel: string;
  confirmLabel: string;
  message: string;
  onConfirm: () => void;
  title: string;
};
type CookbookListItem =
  | { kind: "controls"; key: "controls" }
  | { kind: "prelude"; key: "prelude" }
  | { entry: SavedRecipeRecord; index: number; key: string; kind: "saved" }
  | { entry: SharedRecipe; index: number; key: string; kind: "shared" };

const ROW_ENTER_DURATION_MS = 220;
const ROW_STAGGER_MS = 18;
const ROW_STAGGER_CAP = 8;
const COOKBOOK_SORT_STORAGE_KEY = "linkdish.cookbook.sort.v1";
const COOKBOOK_SORT_DIRECTION_STORAGE_KEY = "linkdish.cookbook.sort-direction.v1";
const LOCKED_FAMILY_HINT_MS = 4000;
/** The controls cell (index 1 after the title header) stays pinned while the list scrolls. */
const STICKY_CONTROLS_INDICES = [1];
const CONTROLS_ITEM: CookbookListItem = { key: "controls", kind: "controls" };
const PRELUDE_ITEM: CookbookListItem = { key: "prelude", kind: "prelude" };

/**
 * Entering animations for the first rows only, built once. They play when the list first
 * mounts; rows mounted later (scrolling, searching, switching tabs) appear without motion.
 * ReduceMotion.System skips them when the OS asks for reduced motion.
 */
const ROW_ENTERING_ANIMATIONS = Array.from({ length: ROW_STAGGER_CAP }, (_, index) =>
  FadeInDown.duration(ROW_ENTER_DURATION_MS)
    .delay(index * ROW_STAGGER_MS)
    .easing(ReanimatedEasing.out(ReanimatedEasing.cubic))
    .reduceMotion(ReduceMotion.System)
);

const keyExtractor = (item: CookbookListItem) => item.key;

const RecipeBookThumbnail = ({ recipe }: { recipe: Pick<Recipe, "image" | "title"> }) => {
  const imageUrl = buildProxiedRecipeImageUrl(recipe.image, 96);

  return (
    <View style={styles.recipeThumbnail}>
      {imageUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          accessible={false}
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
  accessibilityState,
  color = appColors.muted,
  disabled = false,
  name,
  onPress
}: {
  accessibilityLabel: string;
  accessibilityState?: { selected?: boolean };
  color?: string;
  disabled?: boolean;
  name: ComponentProps<typeof MaterialCommunityIcons>["name"];
  onPress: () => void;
}) => (
  <Pressable
    accessibilityLabel={accessibilityLabel}
    accessibilityRole="button"
    {...(accessibilityState ? { accessibilityState } : {})}
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

interface SavedRecipeRowProps {
  canShare: boolean;
  entering: (typeof ROW_ENTERING_ANIMATIONS)[number] | undefined;
  entry: SavedRecipeRecord;
  isLibraryReady: boolean;
  onDuplicate: (id: string) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string, title: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onToggleShared: (id: string, isShared: boolean) => void;
}

const SavedRecipeRow = memo(function SavedRecipeRow({
  canShare,
  entering,
  entry,
  isLibraryReady,
  onDuplicate,
  onOpen,
  onRemove,
  onToggleFavorite,
  onToggleShared
}: SavedRecipeRowProps) {
  const isFavorite = entry.favorite === true;
  const showShare = canShare && !entry.isStarter;

  return (
    <View style={styles.rowFrame}>
      <Reanimated.View {...(entering ? { entering } : {})} style={styles.recipeRow}>
        <Pressable
          onPress={() => onOpen(entry.id)}
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
              {buildRecipeMetaLine(entry.recipe, { compact: true })}
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

        <View style={[styles.recipeActions, showShare && styles.recipeActionsWide]}>
          <IconAction
            accessibilityLabel={isFavorite ? "Remove from favorites" : "Add to favorites"}
            accessibilityState={{ selected: isFavorite }}
            color={isFavorite ? appColors.tomato : appColors.muted}
            name={isFavorite ? "heart" : "heart-outline"}
            onPress={() => onToggleFavorite(entry.id, !isFavorite)}
          />
          <IconAction
            accessibilityLabel="Duplicate recipe"
            color={appColors.accent}
            disabled={!isLibraryReady}
            name="content-copy"
            onPress={() => onDuplicate(entry.id)}
          />
          <IconAction
            accessibilityLabel="Remove recipe"
            name="bookmark-remove-outline"
            onPress={() => onRemove(entry.id, entry.recipe.title)}
          />
          {showShare ? (
            <IconAction
              accessibilityLabel={entry.sharedRecipeId ? "Unshare recipe" : "Share recipe"}
              name={
                entry.sharedRecipeId
                  ? "account-multiple-minus-outline"
                  : "account-multiple-plus-outline"
              }
              onPress={() => onToggleShared(entry.id, entry.sharedRecipeId != null)}
            />
          ) : null}
        </View>
      </Reanimated.View>
    </View>
  );
});

interface SharedRecipeRowProps {
  entering: (typeof ROW_ENTERING_ANIMATIONS)[number] | undefined;
  entry: SharedRecipe;
  isLibraryReady: boolean;
  isOwnedByCurrentUser: boolean;
  onDuplicate: (id: string) => void;
  onOpen: (id: string) => void;
  onUnshare: (id: string, title: string) => void;
}

const SharedRecipeRow = memo(function SharedRecipeRow({
  entering,
  entry,
  isLibraryReady,
  isOwnedByCurrentUser,
  onDuplicate,
  onOpen,
  onUnshare
}: SharedRecipeRowProps) {
  return (
    <View style={styles.rowFrame}>
      <Reanimated.View {...(entering ? { entering } : {})} style={styles.recipeRow}>
        <Pressable
          onPress={() => onOpen(entry.id)}
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
              {buildRecipeMetaLine(entry.recipe, { compact: true })}
            </AppText>
            <AppText muted numberOfLines={1} style={styles.recipeMeta}>
              Owned by {getSharedRecipeOwnerLabel(entry)}
            </AppText>
          </View>
        </Pressable>

        <View
          style={[styles.sharedRecipeActions, isOwnedByCurrentUser && styles.recipeActionsWide]}
        >
          <MaterialCommunityIcons color={appColors.accent} name="chevron-right" size={18} />
          <IconAction
            accessibilityLabel="Save copy"
            color={appColors.accent}
            disabled={!isLibraryReady}
            name="content-copy"
            onPress={() => onDuplicate(entry.id)}
          />
          {isOwnedByCurrentUser ? (
            <IconAction
              accessibilityLabel="Unshare recipe"
              name="account-multiple-minus-outline"
              onPress={() => onUnshare(entry.id, entry.recipe.title)}
            />
          ) : null}
        </View>
      </Reanimated.View>
    </View>
  );
});

export const CookbookScreen = () => {
  const { isSignedIn, user } = useAccount();
  const {
    canUseSharedRecipeBook,
    cloneRecipe,
    cloneSharedRecipe,
    deleteSharedRecipe,
    hasLoadedSavedRecipes,
    hasLoadedSharedRecipes,
    removeRecipe,
    savedRecipes,
    setRecipeFavorite,
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
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [lockedFamilyHintVisible, setLockedFamilyHintVisible] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    account: string | null;
    confirmation: PendingConfirmation;
  } | null>(null);
  /** Who a confirmation is for: one opened by another account (signed in since) isn't shown. */
  const account = isSignedIn && user ? user.id : null;
  const openConfirmation = useCallback(
    (confirmation: PendingConfirmation) => setPendingConfirmation({ account, confirmation }),
    [account]
  );
  const shownConfirmation =
    pendingConfirmation?.account === account ? pendingConfirmation.confirmation : null;
  const [animateFirstRows, setAnimateFirstRows] = useState(true);
  const emptyLibraryLine = useMemo(() => selectFlavorCopyLine(EMPTY_LIBRARY_LINES), []);
  // Typing stays responsive: the list re-filters from a deferred copy of the query.
  const deferredQuery = useDeferredValue(query);
  const hasQuery = deferredQuery.trim().length > 0;
  const activeSortOption = COOKBOOK_SORT_OPTIONS.find(
    (option) => option.value === sort && (activeTab === "personal" || !option.personalOnly)
  );
  const activeSort: CookbookSort = activeSortOption?.value ?? "recent";
  const activeSortLabel = activeSortOption?.label ?? COOKBOOK_SORT_OPTIONS[0]!.label;
  const isFamilyLocked =
    hasLoadedSharedRecipes && !canUseSharedRecipeBook && sharedRecipes.length === 0;
  const isFavoritesFilterOn = activeTab === "personal" && showFavoritesOnly;
  const favoriteCount = useMemo(
    () => savedRecipes.filter((entry) => entry.favorite === true).length,
    [savedRecipes]
  );

  // The search index is built once per library change, and only while a search is active.
  const savedSearchIndex = useMemo(
    () => (hasQuery ? buildSavedRecipeSearchIndex(savedRecipes) : null),
    [hasQuery, savedRecipes]
  );
  const sharedSearchIndex = useMemo(
    () => (hasQuery ? buildSharedRecipeSearchIndex(sharedRecipes) : null),
    [hasQuery, sharedRecipes]
  );
  const filteredSavedRecipes = useMemo(() => {
    const matches = savedSearchIndex
      ? savedSearchIndex.search(deferredQuery).map((result) => result.record)
      : savedRecipes;
    const visible = isFavoritesFilterOn
      ? matches.filter((entry) => entry.favorite === true)
      : matches;

    return sortCookbookRecords(visible, activeSort, sortDirection, {
      getSavedAt: (entry) => entry.savedAt,
      getTimesCooked: (entry) => entry.timesCooked ?? 0
    });
  }, [
    activeSort,
    deferredQuery,
    isFavoritesFilterOn,
    savedRecipes,
    savedSearchIndex,
    sortDirection
  ]);
  const filteredSharedRecipes = useMemo(() => {
    const matches = sharedSearchIndex
      ? sharedSearchIndex.search(deferredQuery).map((result) => result.record)
      : sharedRecipes;

    return sortCookbookRecords(matches, activeSort, sortDirection, {
      getSavedAt: (entry) => entry.createdAt
    });
  }, [activeSort, deferredQuery, sharedRecipes, sharedSearchIndex, sortDirection]);
  const sortDirectionLabel = getSortDirectionLabel(activeSort, sortDirection);
  const hasRows =
    activeTab === "personal" ? filteredSavedRecipes.length > 0 : filteredSharedRecipes.length > 0;

  useEffect(() => {
    // Only the first rows of the first populated render animate in.
    if (animateFirstRows && hasRows) {
      setAnimateFirstRows(false);
    }
  }, [animateFirstRows, hasRows]);

  const clearLockedFamilyHintTimer = useCallback(() => {
    if (lockedFamilyHintTimeoutRef.current) {
      clearTimeout(lockedFamilyHintTimeoutRef.current);
      lockedFamilyHintTimeoutRef.current = null;
    }
  }, []);

  const dismissLockedFamilyHint = useCallback(() => {
    clearLockedFamilyHintTimer();
    setLockedFamilyHintVisible(false);
  }, [clearLockedFamilyHintTimer]);

  const showLockedFamilyHint = () => {
    warnHaptic();
    clearLockedFamilyHintTimer();
    setLockedFamilyHintVisible(true);
    lockedFamilyHintTimeoutRef.current = setTimeout(() => {
      setLockedFamilyHintVisible(false);
      lockedFamilyHintTimeoutRef.current = null;
    }, LOCKED_FAMILY_HINT_MS);
  };

  useEffect(() => () => clearLockedFamilyHintTimer(), [clearLockedFamilyHintTimer]);

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

  const toggleFavoritesFilter = () => {
    selectionTick();
    dismissLockedFamilyHint();
    setShowFavoritesOnly((current) => !current);
  };

  const openImport = useCallback(() => {
    router.push("/import" as never);
  }, []);

  const openSavedRecipe = useCallback((id: string) => {
    router.push({ pathname: "/recipe", params: { savedId: id } });
  }, []);

  const openSharedRecipe = useCallback((id: string) => {
    router.push({ pathname: "/recipe", params: { sharedId: id } });
  }, []);

  const openDuplicateResult = useCallback(
    (result: ReturnType<typeof cloneRecipe>) => {
      if (!result.saved || !result.recipeId) {
        if (!result.allowed && result.reason === "save_limit_reached") {
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
    },
    [showUpgradeMoment]
  );

  const duplicateSavedRecipe = useCallback(
    (id: string) => openDuplicateResult(cloneRecipe(id)),
    [cloneRecipe, openDuplicateResult]
  );

  const duplicateSharedRecipe = useCallback(
    (id: string) => openDuplicateResult(cloneSharedRecipe(id)),
    [cloneSharedRecipe, openDuplicateResult]
  );

  const removeSavedRecipe = useCallback(
    (id: string, title: string) => {
      openConfirmation({
        cancelLabel: "Cancel",
        confirmLabel: "Remove",
        message: `“${title}” will be removed from your cookbook.`,
        onConfirm: () => {
          warnHaptic();
          removeRecipe(id);
        },
        title: "Remove recipe?"
      });
    },
    [openConfirmation, removeRecipe]
  );

  const toggleRecipeShared = useCallback(
    (id: string, isShared: boolean) => {
      if (!isShared) {
        void shareRecipe(id);
        return;
      }

      openConfirmation({
        cancelLabel: "Keep shared",
        confirmLabel: "Unshare",
        message: "Remove this recipe from the Family recipe book?",
        onConfirm: () => {
          void unshareRecipe(id);
        },
        title: "Unshare recipe?"
      });
    },
    [openConfirmation, shareRecipe, unshareRecipe]
  );

  const toggleFavorite = useCallback(
    (id: string, favorite: boolean) => {
      selectionTick();
      setRecipeFavorite(id, favorite);
    },
    [setRecipeFavorite]
  );

  const removeSharedRecipe = useCallback(
    (id: string, title: string) => {
      openConfirmation({
        cancelLabel: "Keep shared",
        confirmLabel: "Unshare",
        message: `Remove "${title}" from the Family recipe book?`,
        onConfirm: () => {
          void deleteSharedRecipe(id);
        },
        title: "Unshare recipe?"
      });
    },
    [deleteSharedRecipe, openConfirmation]
  );

  const listItems = useMemo((): CookbookListItem[] => {
    const hasPrelude =
      activeTab === "personal" && (canUseSharedRecipeBook || sharedRecipeError != null);
    const rows: CookbookListItem[] =
      activeTab === "personal"
        ? hasLoadedSavedRecipes
          ? filteredSavedRecipes.map((entry, index) => ({
              entry,
              index,
              key: `saved:${entry.id}`,
              kind: "saved" as const
            }))
          : []
        : hasLoadedSharedRecipes
          ? filteredSharedRecipes.map((entry, index) => ({
              entry,
              index,
              key: `shared:${entry.id}`,
              kind: "shared" as const
            }))
          : [];

    return [CONTROLS_ITEM, ...(hasPrelude ? [PRELUDE_ITEM] : []), ...rows];
  }, [
    activeTab,
    canUseSharedRecipeBook,
    filteredSavedRecipes,
    filteredSharedRecipes,
    hasLoadedSavedRecipes,
    hasLoadedSharedRecipes,
    sharedRecipeError
  ]);

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

  const renderListMessage = (message: string) => (
    <View style={styles.listMessage}>
      <AppText muted>{message}</AppText>
    </View>
  );

  const renderPersonalFooter = () => {
    if (!hasLoadedSavedRecipes) {
      return renderListMessage("Loading your saved recipes...");
    }

    if (savedRecipes.length === 0) {
      return renderEmptyState(emptyLibraryLine);
    }

    if (filteredSavedRecipes.length > 0) {
      return null;
    }

    if (isFavoritesFilterOn && !hasQuery) {
      return renderListMessage(
        favoriteCount === 0
          ? "No favorites yet. Tap the heart on a recipe to keep it here."
          : "No favorites match this search."
      );
    }

    return renderListMessage(
      isFavoritesFilterOn
        ? "No favorites match this search."
        : "No saved recipes match this search."
    );
  };

  const renderFamilyFooter = () => {
    if (!hasLoadedSharedRecipes) {
      return renderListMessage("Loading shared family recipes...");
    }

    if (sharedRecipes.length === 0) {
      return renderEmptyState(emptyLibraryLine);
    }

    return filteredSharedRecipes.length === 0
      ? renderListMessage("No shared recipes match this search.")
      : null;
  };

  const renderControls = () => (
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
            locked={isFamilyLocked}
            label="Family"
            onPress={() => {
              if (isFamilyLocked) {
                showLockedFamilyHint();
                return;
              }

              dismissLockedFamilyHint();
              setActiveTab("family");
            }}
            style={isFamilyLocked ? styles.segmentButtonDisabled : undefined}
          />
        </View>

        {lockedFamilyHintVisible ? (
          <AppText muted style={styles.lockedFamilyHint}>
            {isSignedIn && user
              ? "Join or create a household from the Household tab to share a Family cookbook."
              : "Sign in from the Household tab to share a Family cookbook."}
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
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />
        </Pressable>

        <View style={styles.sortControls}>
          <View style={styles.sortControlGroup}>
            <Pressable
              accessibilityHint="Opens sorting options"
              accessibilityLabel={`Sort recipes. Current: ${activeSortLabel}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: isSortMenuOpen }}
              onPress={toggleSortMenu}
              style={({ pressed }) => [styles.sortControl, pressed && styles.rowPressed]}
            >
              <AppText style={styles.sortValue}>{activeSortLabel}</AppText>
              <MaterialCommunityIcons
                color={appColors.accent}
                name={isSortMenuOpen ? "chevron-up" : "chevron-down"}
                size={17}
              />
            </Pressable>

            {isSortMenuOpen ? (
              <View accessibilityRole="menu" style={styles.sortMenu} testID="cookbook-sort-menu">
                {COOKBOOK_SORT_OPTIONS.filter(
                  (option) => activeTab === "personal" || !option.personalOnly
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
                        <MaterialCommunityIcons color={appColors.accent} name="check" size={18} />
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

      {activeTab === "personal" ? (
        <View style={styles.filterRow}>
          <Pressable
            accessibilityLabel="Show favorites only"
            accessibilityRole="button"
            accessibilityState={{ selected: showFavoritesOnly }}
            onPress={toggleFavoritesFilter}
            style={({ pressed }) => [
              styles.filterChip,
              showFavoritesOnly && styles.filterChipActive,
              pressed && styles.pressed
            ]}
            testID="cookbook-favorites-filter"
          >
            <MaterialCommunityIcons
              color={showFavoritesOnly ? appColors.onAccent : appColors.tomato}
              name={showFavoritesOnly ? "heart" : "heart-outline"}
              size={15}
            />
            <AppText
              style={[styles.filterChipText, showFavoritesOnly && styles.filterChipTextActive]}
            >
              {favoriteCount > 0 ? `Favorites · ${favoriteCount}` : "Favorites"}
            </AppText>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const renderPrelude = () => (
    <View style={[styles.content, styles.wideSection]}>
      {canUseSharedRecipeBook ? (
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
                    style={[styles.shareModeText, shareMode === mode && styles.shareModeTextActive]}
                  >
                    {mode === "none" ? "Share none" : mode === "all" ? "Share all" : "Selected"}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {sharedRecipeError ? renderListMessage(sharedRecipeError) : null}
    </View>
  );

  const renderItem: ListRenderItem<CookbookListItem> = ({ item }) => {
    switch (item.kind) {
      case "controls":
        return renderControls();
      case "prelude":
        return renderPrelude();
      case "saved":
        return (
          <SavedRecipeRow
            canShare={canUseSharedRecipeBook}
            entering={
              animateFirstRows && item.index < ROW_STAGGER_CAP
                ? ROW_ENTERING_ANIMATIONS[item.index]
                : undefined
            }
            entry={item.entry}
            isLibraryReady={hasLoadedSavedRecipes}
            onDuplicate={duplicateSavedRecipe}
            onOpen={openSavedRecipe}
            onRemove={removeSavedRecipe}
            onToggleFavorite={toggleFavorite}
            onToggleShared={toggleRecipeShared}
          />
        );
      case "shared":
        return (
          <SharedRecipeRow
            entering={
              animateFirstRows && item.index < ROW_STAGGER_CAP
                ? ROW_ENTERING_ANIMATIONS[item.index]
                : undefined
            }
            entry={item.entry}
            isLibraryReady={hasLoadedSavedRecipes}
            isOwnedByCurrentUser={item.entry.ownerUserId === user?.id}
            onDuplicate={duplicateSharedRecipe}
            onOpen={openSharedRecipe}
            onUnshare={removeSharedRecipe}
          />
        );
    }
  };

  return (
    <View style={styles.screen}>
      <FlatList
        ListFooterComponent={
          <View style={[styles.content, styles.wideSection]}>
            {activeTab === "personal" ? renderPersonalFooter() : renderFamilyFooter()}
          </View>
        }
        ListHeaderComponent={
          <View style={[styles.header, styles.wideSection]}>
            <AppText style={styles.title} variant="display">
              Cookbook
            </AppText>
          </View>
        }
        contentContainerStyle={[
          styles.container,
          {
            paddingBottom: Math.max(insets.bottom, appSpacing.xl) + 96,
            paddingTop: Math.max(insets.top, appSpacing.lg) + appSpacing.lg
          }
        ]}
        data={listItems}
        initialNumToRender={12}
        keyExtractor={keyExtractor}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        maxToRenderPerBatch={10}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={STICKY_CONTROLS_INDICES}
        windowSize={9}
      />
      <AppDialog
        actions={
          shownConfirmation
            ? [
                {
                  label: shownConfirmation.cancelLabel,
                  onPress: () => setPendingConfirmation(null),
                  variant: "outline"
                },
                {
                  label: shownConfirmation.confirmLabel,
                  onPress: () => {
                    const action = shownConfirmation.onConfirm;
                    setPendingConfirmation(null);
                    action();
                  },
                  variant: "danger"
                }
              ]
            : []
        }
        message={shownConfirmation?.message ?? ""}
        onRequestClose={() => setPendingConfirmation(null)}
        title={shownConfirmation?.title ?? ""}
        visible={shownConfirmation != null}
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
  filterChip: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 34,
    paddingHorizontal: appSpacing.md
  },
  filterChipActive: {
    backgroundColor: appColors.tomato,
    borderColor: appColors.tomato
  },
  filterChipText: {
    color: appColors.text,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 17
  },
  filterChipTextActive: {
    color: appColors.onAccent
  },
  filterRow: {
    flexDirection: "row",
    gap: appSpacing.sm,
    marginTop: appSpacing.md
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
  rowFrame: {
    alignSelf: "center",
    maxWidth: 900,
    paddingHorizontal: appSpacing.lg,
    width: "100%"
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
  searchSortRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: appSpacing.xxl
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
  sharedRecipeActions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    width: 108
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
  tabGroup: {
    gap: appSpacing.sm
  },
  tabRow: {
    backgroundColor: appColors.accentSoft,
    borderRadius: 19,
    flexDirection: "row",
    gap: appSpacing.xs,
    padding: appSpacing.xs
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
