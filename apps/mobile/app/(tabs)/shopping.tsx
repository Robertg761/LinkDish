import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { useShoppingList } from "../../src/features/shopping/ShoppingListContext";
import {
  shoppingTextFromQuantity,
  type MobileShoppingItem,
  type ShoppingSyncStatus
} from "../../src/features/shopping/store";
import { selectionTick } from "../../src/lib/haptics";
import { appColors, appSpacing } from "../../src/theme/tokens";

interface ShoppingGroup {
  key: string;
  title: string;
  items: MobileShoppingItem[];
}

const statusLabels: Record<ShoppingSyncStatus, string> = {
  dirty: "Syncing",
  local_only: "On this device",
  sync_failed: "Retry on refresh",
  synced: ""
};

const getGroupKey = (item: MobileShoppingItem): string => item.recipeId ?? "everything-else";

const getRecipeMonogram = (title: string): string =>
  title
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "LD";

const buildShoppingGroups = (items: MobileShoppingItem[]): ShoppingGroup[] => {
  const groups = new Map<string, ShoppingGroup>();

  for (const item of items) {
    const key = getGroupKey(item);
    const title = item.recipeTitle?.trim() || "Everything else";
    const existing = groups.get(key);

    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      items: [item],
      key,
      title
    });
  }

  const recipeGroups = Array.from(groups.values()).filter(
    (group) => group.key !== "everything-else"
  );
  const everythingElse = groups.get("everything-else");

  return [...recipeGroups, ...(everythingElse ? [everythingElse] : [])];
};

const ShoppingItemRow = ({
  item,
  onDelete,
  onToggle
}: {
  item: MobileShoppingItem;
  onDelete: (id: string) => void;
  onToggle: (id: string, checked: boolean) => void;
}) => {
  const displayText = shoppingTextFromQuantity(item.qty, item.unit, item.text);
  const statusLabel = statusLabels[item.sync.status];

  return (
    <Pressable
      accessibilityLabel={`${item.checked ? "Remove from cart" : "Mark in cart"} ${displayText}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: item.checked }}
      onPress={() => {
        selectionTick();
        onToggle(item.id, !item.checked);
      }}
      style={({ pressed }) => [styles.itemRow, pressed && styles.pressed]}
    >
      <View style={[styles.itemCheck, item.checked && styles.itemCheckChecked]}>
        {item.checked ? (
          <MaterialCommunityIcons color={appColors.canvas} name="check" size={13} />
        ) : null}
      </View>
      <View style={styles.itemCopy}>
        <AppText
          style={[styles.itemText, item.checked && styles.itemTextChecked]}
          numberOfLines={2}
        >
          {displayText}
        </AppText>
        {statusLabel ? (
          <AppText muted style={styles.statusText}>
            {statusLabel}
          </AppText>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={`Delete ${displayText}`}
        accessibilityRole="button"
        hitSlop={10}
        onPress={() => onDelete(item.id)}
        style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
      >
        <MaterialCommunityIcons color={appColors.muted} name="trash-can-outline" size={18} />
      </Pressable>
    </Pressable>
  );
};

export default function ShoppingScreen() {
  const insets = useSafeAreaInsets();
  const {
    addItems,
    canSyncShoppingList,
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
  const activeItems = useMemo(() => shoppingItems.filter((item) => !item.checked), [shoppingItems]);
  const checkedItems = useMemo(() => shoppingItems.filter((item) => item.checked), [shoppingItems]);
  const isShoppingListEmpty = activeItems.length === 0 && checkedItems.length === 0;
  const groups = useMemo(() => buildShoppingGroups(activeItems), [activeItems]);

  useFocusEffect(
    useCallback(() => {
      void refreshShoppingList();
    }, [refreshShoppingList])
  );

  const submitQuickAdd = () => {
    const text = quickAddText.trim();

    if (!text) {
      return;
    }

    addItems([{ text }]);
    setQuickAddText("");
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

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <AppText style={styles.title} variant="display">
          Shopping List
        </AppText>
        <AppText muted style={styles.subtitle}>
          {canSyncShoppingList
            ? "Shared with your household when you refresh."
            : "Personal list on this device. Family sharing unlocks a shared household list."}
        </AppText>
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
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, appSpacing.xl) + appSpacing.xl
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

          {groups.map((group) => (
            <AppSurface key={group.key} style={styles.group}>
              <View style={styles.groupHeader}>
                <View style={styles.groupMark}>
                  <AppText style={styles.groupMarkText}>
                    {group.key === "everything-else" ? "..." : getRecipeMonogram(group.title)}
                  </AppText>
                </View>
                <AppText style={styles.groupTitle} variant="title">
                  {group.title}
                </AppText>
              </View>
              <View style={styles.itemStack}>
                {group.items.map((item) => (
                  <ShoppingItemRow
                    item={item}
                    key={item.id}
                    onDelete={deleteItem}
                    onToggle={setItemChecked}
                  />
                ))}
              </View>
            </AppSurface>
          ))}

          {checkedItems.length > 0 ? (
            <AppSurface style={styles.group}>
              <Pressable
                accessibilityLabel={isCartExpanded ? "Collapse in the cart" : "Expand in the cart"}
                accessibilityRole="button"
                onPress={() => setIsCartExpanded((expanded) => !expanded)}
                style={({ pressed }) => [styles.cartHeader, pressed && styles.pressed]}
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
              {isCartExpanded ? (
                <View style={styles.itemStack}>
                  {checkedItems.map((item) => (
                    <ShoppingItemRow
                      item={item}
                      key={item.id}
                      onDelete={deleteItem}
                      onToggle={setItemChecked}
                    />
                  ))}
                </View>
              ) : null}
            </AppSurface>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cartHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md
  },
  cartHeaderCopy: {
    flex: 1,
    gap: 3
  },
  centerText: {
    textAlign: "center"
  },
  content: {
    alignSelf: "center",
    gap: appSpacing.md,
    maxWidth: 760,
    padding: appSpacing.lg,
    width: "100%"
  },
  deleteButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34
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
    alignSelf: "center",
    gap: appSpacing.sm,
    maxWidth: 760,
    paddingHorizontal: appSpacing.lg,
    paddingTop: appSpacing.lg,
    width: "100%"
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
  itemRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md,
    minHeight: 44
  },
  itemStack: {
    gap: 10
  },
  itemText: {
    flex: 1
  },
  itemTextChecked: {
    color: appColors.muted,
    textDecorationLine: "line-through"
  },
  notice: {
    paddingVertical: appSpacing.md
  },
  pressed: {
    opacity: 0.72
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
  subtitle: {
    fontSize: 15,
    lineHeight: 22
  },
  title: {
    fontSize: 38,
    lineHeight: 42
  }
});
