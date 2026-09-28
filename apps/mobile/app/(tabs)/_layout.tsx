import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import React from "react";
import { StyleSheet } from "react-native";

import { CookbookTabIcon } from "../../src/features/navigation/CookbookTabIcon";
import { flushRecipeBookBounce } from "../../src/features/navigation/recipeBookBounceEvents";
import { appColors } from "../../src/theme/tokens";

import type { ComponentProps } from "react";

const tabIcons = {
  account: "home-heart",
  import: "plus-circle-outline",
  index: "book-open-variant",
  shopping: "cart-outline"
} as const satisfies Record<string, ComponentProps<typeof MaterialCommunityIcons>["name"]>;

// A tab screen regains focus when the recipe screen that covered the tab bar closes, so that
// is when a "recipe saved" bounce requested on the recipe screen can actually be seen.
const tabScreenListeners = {
  focus: () => {
    flushRecipeBookBounce();
  }
};

export default function TabLayout() {
  return (
    <Tabs
      initialRouteName="index"
      screenListeners={tabScreenListeners}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: appColors.accent,
        tabBarInactiveTintColor: appColors.muted,
        tabBarIcon: ({ color, size }) => {
          const name = tabIcons[route.name as keyof typeof tabIcons];

          return route.name === "index" ? (
            <CookbookTabIcon color={color} name={name} size={size} />
          ) : (
            <MaterialCommunityIcons color={color} name={name} size={size} />
          );
        },
        tabBarLabelStyle: styles.tabLabel,
        tabBarStyle: styles.tabBar
      })}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Cookbook"
        }}
      />
      <Tabs.Screen
        name="import"
        options={{
          title: "Add"
        }}
      />
      <Tabs.Screen
        name="shopping"
        options={{
          title: "Shopping"
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Household"
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: appColors.surface,
    borderTopColor: appColors.border,
    borderTopWidth: 1,
    elevation: 0
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: "600"
  }
});
