import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "expo-router";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppDialog } from "../../src/components/AppDialog";
import { useTabBarScroll } from "../../src/features/navigation/TabBarVisibility";
import { useSavedRecipes } from "../../src/features/saved-recipes/SavedRecipesContext";
import { useShoppingList } from "../../src/features/shopping/ShoppingListContext";
import {
  getShoppingIngredientKey,
  getShoppingItemDisplayText,
  getShoppingRecipeSources,
  groupShoppingItemsByAisle,
  type MobileShoppingItem
} from "../../src/features/shopping/store";
import { selectionTick } from "../../src/lib/haptics";
import { appColors, appSpacing } from "../../src/theme/tokens";

export type ShoppingGroupMode = "aisle" | "recipe";

interface ShoppingGroup {
  key: string;
  kind: "aisle" | "other" | "recipe";
  title: string;
  items: MobileShoppingItem[];
}

export const SHOPPING_GROUP_MODE_STORAGE_KEY = "linkdish.shopping.groupMode.v1";
const EVERYTHING_ELSE_KEY = "everything-else";

const isShoppingGroupMode = (value: string | null): value is ShoppingGroupMode =>
  value === "aisle" || value === "recipe";

const getRecipeGroupKey = (item: MobileShoppingItem): string =>
  item.recipeId ?? EVERYTHING_ELSE_KEY;

const getRecipeMonogram = (title: string): string =>
  title
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "LD";

const buildRecipeGroups = (items: MobileShoppingItem[]): ShoppingGroup[] => {
  const groups = new Map<string, ShoppingGroup>();

  for (const item of items) {
    const key = getRecipeGroupKey(item);
    const existing = groups.get(key);

    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      items: [item],
      key,
      kind: key === EVERYTHING_ELSE_KEY ? "other" : "recipe",
      title: item.recipeTitle?.trim() || "Everything else"
    });
  }

  const recipeGroups = Array.from(groups.values()).filter(
    (group) => group.key !== EVERYTHING_ELSE_KEY
  );
  const everythingElse = groups.get(EVERYTHING_ELSE_KEY);

  return [...recipeGroups, ...(everythingElse ? [everythingElse] : [])];
};

const buildAisleGroups = (items: MobileShoppingItem[]): ShoppingGroup[] =>
  groupShoppingItemsByAisle(items).map((group) => ({
    items: group.items,
    key: group.category,
    kind: "aisle",
    title: group.label
  }));

const DETAILS_ANIMATION_MS = 280;
const SYNC_SPIN_MS = 1100;

interface SuggestedRecipe {
  id: string;
  title: string;
}

const NO_SUGGESTIONS: SuggestedRecipe[] = [];

/** A small spinning icon while an item's change is on its way to the household list. */
const SyncingIndicator = () => {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, {
        duration: SYNC_SPIN_MS,
        easing: ReanimatedEasing.linear,
        reduceMotion: ReduceMotion.System
      }),
      -1
    );
    return () => cancelAnimation(rotation);
  }, [rotation]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }]
  }));

  return (
    <Reanimated.View
      accessibilityLabel="Syncing"
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(220)}
      style={[styles.syncIndicator, spinStyle]}
    >
      <MaterialCommunityIcons color={appColors.accent} name="autorenew" size={16} />
    </Reanimated.View>
  );
};

const ShoppingItemRow = memo(function ShoppingItemRow({
  isSyncing,
  item,
  onDelete,
  onToggle,
  showDivider,
  statusLabel,
  suggestedRecipes
}: {
  isSyncing: boolean;
  item: MobileShoppingItem;
  onDelete: (id: string) => void;
  onToggle: (id: string, checked: boolean) => void;
  showDivider: boolean;
  statusLabel: string | null;
  suggestedRecipes: SuggestedRecipe[];
}) {
  const displayText = getShoppingItemDisplayText(item);
  const recipeSources = getShoppingRecipeSources(item);
  const [expanded, setExpanded] = useState(false);
  // Details stay mounted until the collapse animation finishes so they can animate out.
  const [detailsMounted, setDetailsMounted] = useState(false);
  const progress = useSharedValue(0);
  const detailsHeight = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(
      expanded ? 1 : 0,
      {
        duration: DETAILS_ANIMATION_MS,
        easing: ReanimatedEasing.inOut(ReanimatedEasing.cubic),
        reduceMotion: ReduceMotion.System
      },
      (finished) => {
        if (finished && !expanded) {
          runOnJS(setDetailsMounted)(false);
        }
      }
    );
  }, [expanded, progress]);

  const detailsStyle = useAnimatedStyle(() => ({
    height: detailsHeight.value * progress.value,
    opacity: progress.value
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 180}deg` }]
  }));

  const toggleExpanded = () => {
    if (!expanded) {
      setDetailsMounted(true);
    }
    setExpanded(!expanded);
  };

  return (
    <View style={[styles.itemBlock, showDivider && styles.itemDivider]}>
      <View style={styles.itemRow}>
        <Pressable
          accessibilityLabel={`${item.checked ? "Remove from cart" : "Mark in cart"} ${displayText}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.checked }}
          onPress={() => {
            selectionTick();
            onToggle(item.id, !item.checked);
          }}
          style={({ pressed }) => [styles.itemMain, pressed && styles.pressed]}
        >
          <View style={[styles.itemCheck, item.checked && styles.itemCheckChecked]}>
            {item.checked ? (
              <MaterialCommunityIcons color={appColors.canvas} name="check" size={13} />
            ) : null}
          </View>
          <View style={styles.itemCopy}>
            <AppText style={item.checked ? styles.itemTextChecked : undefined} numberOfLines={2}>
              {displayText}
            </AppText>
            {statusLabel ? (
              <AppText muted style={styles.statusText}>
                {statusLabel}
              </AppText>
            ) : null}
          </View>
          {isSyncing ? <SyncingIndicator /> : null}
        </Pressable>
        <Pressable
          accessibilityLabel={`${expanded ? "Hide" : "Show"} recipes for ${displayText}`}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={6}
          onPress={toggleExpanded}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Reanimated.View style={chevronStyle}>
            <MaterialCommunityIcons color={appColors.muted} name="chevron-down" size={22} />
          </Reanimated.View>
        </Pressable>
        <Pressable
          accessibilityLabel={`Delete ${displayText}`}
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => onDelete(item.id)}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons color={appColors.muted} name="trash-can-outline" size={18} />
        </Pressable>
      </View>
      {detailsMounted ? (
        <Reanimated.View style={[styles.recipeDetailsClip, detailsStyle]}>
          <View
            onLayout={(event) => {
              detailsHeight.value = event.nativeEvent.layout.height;
            }}
            style={styles.recipeDetailsMeasure}
          >
            <View style={styles.recipeDetails}>
              <View style={styles.recipeSection}>
                <AppText style={styles.recipeSectionLabel} tone="accent" variant="label">
                  Added from
                </AppText>
                {recipeSources.length > 0 ? (
                  recipeSources.map((source) => (
                    <View key={source.recipeId} style={styles.recipeLine}>
                      <MaterialCommunityIcons
                        color={appColors.accent}
                        name="book-open-page-variant-outline"
                        size={16}
                      />
                      <AppText style={styles.recipeTitle}>{source.recipeTitle}</AppText>
                    </View>
                  ))
                ) : (
                  <AppText muted style={styles.recipeTitle}>
                    Added by hand
                  </AppText>
                )}
              </View>
              {suggestedRecipes.length > 0 ? (
                <View style={[styles.recipeSection, styles.recipeSectionDivided]}>
                  <AppText style={styles.recipeSectionLabel} variant="label">
                    Also in your cookbook
                  </AppText>
                  {suggestedRecipes.map((recipe) => (
                    <View key={recipe.id} style={styles.recipeLine}>
                      <MaterialCommunityIcons
                        color={appColors.muted}
                        name="book-outline"
                        size={16}
                      />
                      <AppText muted style={styles.recipeTitle}>
                        {recipe.title}
                      </AppText>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        </Reanimated.View>
      ) : null}
    </View>
  );
});

/**
 * Per-row sync status, kept quiet: a failed push always shows, and "On this device" only
 * shows inside a shared household list (for items added before joining). Pending pushes show
 * as SyncingIndicator's small icon rather than a "Syncing" line under every check-off.
 */
const getStatusLabel = (item: MobileShoppingItem, isSharedList: boolean): string | null => {
  if (item.sync.status === "sync_failed") {
    return "Retry on refresh";
  }

  return isSharedList && item.sync.status === "local_only" ? "On this device" : null;
};

const GroupModeToggle = ({
  mode,
  onChange
}: {
  mode: ShoppingGroupMode;
  onChange: (mode: ShoppingGroupMode) => void;
}) => (
  <View accessibilityRole="tablist" style={styles.modeRow} testID="shopping-group-mode">
    {(
      [
        { label: "By aisle", value: "aisle" },
        { label: "By recipe", value: "recipe" }
      ] as const
    ).map((option) => {
      const selected = option.value === mode;

      return (
        <Pressable
          accessibilityLabel={`Group ${option.label.toLowerCase()}`}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          key={option.value}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => [
            styles.modeOption,
            selected && styles.modeOptionSelected,
            pressed && styles.pressed
          ]}
        >
          <AppText style={[styles.modeOptionText, selected && styles.modeOptionTextSelected]}>
            {option.label}
          </AppText>
        </Pressable>
      );
    })}
  </View>
);

export default function ShoppingScreen() {
  const onTabScroll = useTabBarScroll();
  const insets = useSafeAreaInsets();
  const {
    addItems,
    canSyncShoppingList,
    clearCheckedItems,
    deleteItem,
    hasLoadedShoppingItems,
    isRefreshingShoppingList,
    refreshShoppingList,
    setItemChecked,
    shoppingError,
    shoppingItems
  } = useShoppingList();
  const [quickAddText, setQuickAddText] = useState("");
  const [isCartExpanded, setIsCartExpanded] = useState(false);
  const [isClearCheckedDialogVisible, setIsClearCheckedDialogVisible] = useState(false);
  const [groupMode, setGroupMode] = useState<ShoppingGroupMode>("aisle");
  const [isInfoDialogVisible, setIsInfoDialogVisible] = useState(false);
  const { savedRecipes } = useSavedRecipes();
  const activeItems = useMemo(() => shoppingItems.filter((item) => !item.checked), [shoppingItems]);
  const checkedItems = useMemo(() => shoppingItems.filter((item) => item.checked), [shoppingItems]);
  const isShoppingListEmpty = activeItems.length === 0 && checkedItems.length === 0;
  const cookbookIngredientKeys = useMemo(
    () =>
      savedRecipes.map((record) => ({
        id: record.id,
        keys: new Set(
          record.recipe.ingredients.map((ingredient) => getShoppingIngredientKey(ingredient.text))
        ),
        title: record.recipe.title
      })),
    [savedRecipes]
  );
  // Other saved recipes that call for each item, besides the ones it was added from.
  const suggestionsByItem = useMemo(() => {
    const suggestions = new Map<string, SuggestedRecipe[]>();

    for (const item of shoppingItems) {
      const key = getShoppingIngredientKey(item.text);
      const sourceIds = new Set(getShoppingRecipeSources(item).map((source) => source.recipeId));
      const matches = cookbookIngredientKeys
        .filter((recipe) => !sourceIds.has(recipe.id) && recipe.keys.has(key))
        .map(({ id, title }) => ({ id, title }));

      if (matches.length > 0) {
        suggestions.set(item.id, matches);
      }
    }

    return suggestions;
  }, [cookbookIngredientKeys, shoppingItems]);
  const groups = useMemo(
    () => (groupMode === "aisle" ? buildAisleGroups(activeItems) : buildRecipeGroups(activeItems)),
    [activeItems, groupMode]
  );

  useEffect(() => {
    let isActive = true;

    void AsyncStorage.getItem(SHOPPING_GROUP_MODE_STORAGE_KEY)
      .then((storedMode) => {
        if (isActive && isShoppingGroupMode(storedMode)) {
          setGroupMode(storedMode);
        }
      })
      .catch(() => undefined);

    return () => {
      isActive = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshShoppingList();
    }, [refreshShoppingList])
  );

  const changeGroupMode = useCallback((mode: ShoppingGroupMode) => {
    selectionTick();
    setGroupMode(mode);
    void AsyncStorage.setItem(SHOPPING_GROUP_MODE_STORAGE_KEY, mode).catch(() => undefined);
  }, []);

  const submitQuickAdd = () => {
    const text = quickAddText.trim();

    if (!text) {
      return;
    }

    addItems([{ text }]);
    setQuickAddText("");
  };

  const confirmClearChecked = () => {
    setIsClearCheckedDialogVisible(false);
    clearCheckedItems();
    setIsCartExpanded(false);
  };

  const renderEmptyState = () =>
    hasLoadedShoppingItems ? (
      <AppSurface style={styles.emptyState} tone="subtle">
        <MaterialCommunityIcons color={appColors.accent} name="basket-outline" size={26} />
        <AppText style={styles.emptyTitle} variant="title">
          Your shopping list is empty.
        </AppText>
        <AppText muted style={styles.centerText}>
          Add ingredients from any recipe.
        </AppText>
      </AppSurface>
    ) : (
      <AppText muted>Loading your shopping list...</AppText>
    );

  const renderGroupMark = (group: ShoppingGroup) => {
    if (group.kind === "aisle") {
      return null;
    }

    return (
      <View style={styles.groupMark}>
        <AppText style={styles.groupMarkText}>
          {group.kind === "other" ? "..." : getRecipeMonogram(group.title)}
        </AppText>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <AppText style={styles.title} variant="display">
          Shopping List
        </AppText>
        <Pressable
          accessibilityLabel="Shopping list information"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => setIsInfoDialogVisible(true)}
          style={({ pressed }) => [styles.infoButton, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons color={appColors.muted} name="information-outline" size={23} />
        </Pressable>
      </View>

      <View style={styles.quickAdd}>
        <TextInput
          autoCapitalize="sentences"
          onChangeText={setQuickAddText}
          onSubmitEditing={submitQuickAdd}
          placeholder="Add olive oil"
          placeholderTextColor={appColors.placeholder}
          returnKeyType="done"
          style={styles.quickAddInput}
          value={quickAddText}
        />
        <AppButton
          disabled={!quickAddText.trim()}
          label="Add"
          onPress={submitQuickAdd}
          style={styles.quickAddButton}
        />
      </View>

      <ScrollView
        onScroll={onTabScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, appSpacing.xl) + 100
        }}
        refreshControl={
          <RefreshControl refreshing={isRefreshingShoppingList} onRefresh={refreshShoppingList} />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          {shoppingError ? (
            <AppSurface style={styles.notice} tone="subtle">
              <AppText muted>{shoppingError}</AppText>
            </AppSurface>
          ) : null}

          {isShoppingListEmpty ? renderEmptyState() : null}

          {activeItems.length > 0 ? (
            <GroupModeToggle mode={groupMode} onChange={changeGroupMode} />
          ) : null}

          {groups.map((group) => (
            <AppSurface key={group.key} style={styles.group}>
              <View style={styles.groupHeader}>
                {renderGroupMark(group)}
                {group.kind === "aisle" ? (
                  <AppText style={styles.groupTitle} tone="accent" variant="label">
                    {group.title}
                  </AppText>
                ) : (
                  <AppText style={styles.groupTitle} variant="title">
                    {group.title}
                  </AppText>
                )}
              </View>
              <View style={styles.itemStack}>
                {group.items.map((item, index) => (
                  <ShoppingItemRow
                    isSyncing={item.sync.status === "dirty"}
                    item={item}
                    key={item.id}
                    onDelete={deleteItem}
                    onToggle={setItemChecked}
                    showDivider={index > 0}
                    statusLabel={getStatusLabel(item, canSyncShoppingList)}
                    suggestedRecipes={suggestionsByItem.get(item.id) ?? NO_SUGGESTIONS}
                  />
                ))}
              </View>
            </AppSurface>
          ))}

          {checkedItems.length > 0 ? (
            <AppSurface style={styles.group}>
              <View style={styles.cartHeader}>
                <Pressable
                  accessibilityLabel={
                    isCartExpanded ? "Collapse in the cart" : "Expand in the cart"
                  }
                  accessibilityRole="button"
                  onPress={() => setIsCartExpanded((expanded) => !expanded)}
                  style={({ pressed }) => [styles.cartToggle, pressed && styles.pressed]}
                >
                  <View style={styles.cartHeaderCopy}>
                    <AppText tone="accent" variant="label">
                      In the cart
                    </AppText>
                    <AppText muted>
                      {checkedItems.length === 1
                        ? "1 item checked off"
                        : `${checkedItems.length} items checked off`}
                    </AppText>
                  </View>
                  <MaterialCommunityIcons
                    color={appColors.muted}
                    name={isCartExpanded ? "chevron-up" : "chevron-down"}
                    size={22}
                  />
                </Pressable>
                <Pressable
                  accessibilityLabel="Clear checked items"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setIsClearCheckedDialogVisible(true)}
                  style={({ pressed }) => [styles.clearCheckedButton, pressed && styles.pressed]}
                >
                  <AppText style={styles.clearCheckedText}>Clear</AppText>
                </Pressable>
              </View>
              {isCartExpanded ? (
                <View style={styles.itemStack}>
                  {checkedItems.map((item, index) => (
                    <ShoppingItemRow
                      isSyncing={item.sync.status === "dirty"}
                      item={item}
                      key={item.id}
                      onDelete={deleteItem}
                      onToggle={setItemChecked}
                      showDivider={index > 0}
                      statusLabel={getStatusLabel(item, canSyncShoppingList)}
                      suggestedRecipes={suggestionsByItem.get(item.id) ?? NO_SUGGESTIONS}
                    />
                  ))}
                </View>
              ) : null}
            </AppSurface>
          ) : null}
        </View>
      </ScrollView>
      <AppDialog
        actions={[
          {
            label: "Keep them",
            onPress: () => setIsClearCheckedDialogVisible(false),
            variant: "outline"
          },
          {
            label: "Clear",
            onPress: confirmClearChecked,
            variant: "danger"
          }
        ]}
        message={
          checkedItems.length === 1
            ? "The item you checked off will be removed from this list."
            : `The ${checkedItems.length} items you checked off will be removed from this list.`
        }
        onRequestClose={() => setIsClearCheckedDialogVisible(false)}
        title="Clear checked items?"
        visible={isClearCheckedDialogVisible}
      />
      <AppDialog
        actions={[{ label: "Got it", onPress: () => setIsInfoDialogVisible(false) }]}
        message={
          canSyncShoppingList
            ? "Your shopping list is shared with your household when you refresh."
            : "Your shopping list is stored on this device. Family sharing unlocks a shared household list."
        }
        onRequestClose={() => setIsInfoDialogVisible(false)}
        title="Shopping list"
        visible={isInfoDialogVisible}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cartHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm
  },
  cartHeaderCopy: {
    flex: 1,
    gap: 3
  },
  cartToggle: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: appSpacing.md
  },
  centerText: {
    textAlign: "center"
  },
  clearCheckedButton: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: appSpacing.md
  },
  clearCheckedText: {
    color: appColors.dangerText,
    fontSize: 14,
    fontWeight: "700"
  },
  content: {
    alignSelf: "center",
    gap: appSpacing.md,
    maxWidth: 760,
    padding: appSpacing.lg,
    width: "100%"
  },

  emptyState: {
    alignItems: "center",
    gap: appSpacing.sm
  },
  emptyTitle: {
    textAlign: "center"
  },
  group: {
    gap: appSpacing.md
  },
  groupHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md
  },
  groupMark: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderColor: "rgba(41, 68, 59, 0.16)",
    borderRadius: 12,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  groupMarkText: {
    color: appColors.accent,
    fontSize: 13,
    fontWeight: "800"
  },
  groupTitle: {
    flex: 1
  },
  header: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: appSpacing.sm,
    maxWidth: 760,
    paddingHorizontal: appSpacing.lg,
    paddingTop: appSpacing.lg,
    width: "100%"
  },
  iconButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  infoButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44
  },
  itemBlock: {
    paddingVertical: appSpacing.sm
  },
  itemCheck: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 23,
    justifyContent: "center",
    width: 23
  },
  itemCheckChecked: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  itemCopy: {
    flex: 1,
    gap: 2
  },
  itemDivider: {
    borderTopColor: appColors.border,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  itemMain: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: appSpacing.md,
    minHeight: 44
  },
  itemRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
    minHeight: 44
  },
  itemStack: {
    gap: 0
  },
  itemTextChecked: {
    color: appColors.muted,
    textDecorationLine: "line-through"
  },
  modeOption: {
    alignItems: "center",
    borderRadius: 14,
    flex: 1,
    justifyContent: "center",
    minHeight: 38,
    paddingHorizontal: appSpacing.md
  },
  modeOptionSelected: {
    backgroundColor: appColors.surface
  },
  modeOptionText: {
    color: appColors.muted,
    fontSize: 14,
    fontWeight: "700"
  },
  modeOptionTextSelected: {
    color: appColors.text
  },
  modeRow: {
    backgroundColor: appColors.accentSoft,
    borderRadius: 18,
    flexDirection: "row",
    gap: appSpacing.xs,
    padding: appSpacing.xs
  },
  notice: {
    paddingVertical: appSpacing.md
  },
  pressed: {
    opacity: 0.72
  },
  recipeDetails: {
    backgroundColor: appColors.background,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: appSpacing.md,
    marginLeft: 35,
    padding: appSpacing.md
  },
  recipeDetailsClip: {
    overflow: "hidden"
  },
  // Laid out free of the clip's animated height so onLayout reports the full content height.
  recipeDetailsMeasure: {
    left: 0,
    paddingTop: appSpacing.sm,
    position: "absolute",
    right: 0,
    top: 0
  },
  recipeLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm
  },
  recipeSection: {
    gap: 6
  },
  recipeSectionDivided: {
    borderTopColor: appColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: appSpacing.md
  },
  recipeSectionLabel: {
    fontSize: 11,
    letterSpacing: 1
  },
  recipeTitle: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21
  },
  quickAdd: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: appColors.background,
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: appSpacing.sm,
    maxWidth: 760,
    padding: appSpacing.lg,
    width: "100%"
  },
  quickAddButton: {
    minHeight: 48,
    paddingHorizontal: 18
  },
  quickAddInput: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: appColors.text,
    flex: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  statusText: {
    fontSize: 12,
    lineHeight: 16
  },
  syncIndicator: {
    alignItems: "center",
    height: 16,
    justifyContent: "center",
    width: 16
  },
  title: {
    flex: 1,
    fontSize: 38,
    lineHeight: 50
  }
});
