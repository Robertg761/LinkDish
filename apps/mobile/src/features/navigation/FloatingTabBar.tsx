import { MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { Animated, Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { useReduceMotion } from "../../hooks/useReduceMotion";
import { appColors } from "../../theme/tokens";

import { useTabBarVisibility } from "./TabBarVisibility";

import type { Tabs } from "expo-router";
import type { ComponentProps } from "react";

const icons = {
  account: "home-heart",
  import: "plus-circle-outline",
  index: "book-open-variant",
  plan: "calendar-week",
  shopping: "cart-outline"
} as const satisfies Record<string, ComponentProps<typeof MaterialCommunityIcons>["name"]>;

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];

export const FloatingTabBar = ({
  state,
  descriptors,
  emitter,
  navigateToTab,
  insets
}: TabBarProps) => {
  const reduceMotion = useReduceMotion();
  const { visible, setVisible } = useTabBarVisibility();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const selected = useRef(new Animated.Value(state.index)).current;
  const reveal = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      selected.setValue(state.index);
      setVisible(true);
      return;
    }
    Animated.spring(selected, {
      toValue: state.index,
      speed: 18,
      bounciness: 3,
      useNativeDriver: true
    }).start();
    setVisible(true);
  }, [reduceMotion, selected, setVisible, state.index]);

  useEffect(() => {
    if (reduceMotion) {
      reveal.setValue(visible && !keyboardVisible ? 1 : 0);
      return;
    }
    Animated.timing(reveal, {
      toValue: visible && !keyboardVisible ? 1 : 0,
      duration: 220,
      useNativeDriver: true
    }).start();
  }, [keyboardVisible, reduceMotion, reveal, visible]);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const itemWidth = width / state.routes.length;
  return (
    <Animated.View
      pointerEvents={visible && !keyboardVisible ? "box-none" : "none"}
      accessibilityElementsHidden={!visible || keyboardVisible}
      importantForAccessibility={visible && !keyboardVisible ? "auto" : "no-hide-descendants"}
      style={[
        styles.position,
        {
          bottom: Math.max(insets.bottom, 12) + 8,
          opacity: reveal,
          transform: [
            { translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [100, 0] }) }
          ]
        }
      ]}
    >
      <View style={styles.pill} onLayout={(event) => setWidth(event.nativeEvent.layout.width - 12)}>
        {itemWidth > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicator,
              {
                width: itemWidth,
                transform: [{ translateX: Animated.multiply(selected, itemWidth) }]
              }
            ]}
          />
        )}
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key]?.options;
          const label =
            typeof options?.tabBarLabel === "string"
              ? options.tabBarLabel
              : (options?.title ?? route.name);
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
              onPress={() => {
                const event = emitter.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true
                });
                if (!focused && !event.defaultPrevented) navigateToTab(route.key);
                setVisible(true);
              }}
              onLongPress={() => emitter.emit({ type: "tabLongPress", target: route.key })}
              style={styles.item}
            >
              {options?.tabBarIcon ? (
                options.tabBarIcon({
                  focused,
                  size: 22,
                  color: focused ? appColors.accent : appColors.muted
                })
              ) : (
                <MaterialCommunityIcons
                  name={icons[route.name as keyof typeof icons]}
                  size={22}
                  color={focused ? appColors.accent : appColors.muted}
                />
              )}
              <Text style={[styles.label, focused && styles.activeLabel]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  position: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  pill: {
    width: "100%",
    maxWidth: 560,
    height: 68,
    padding: 6,
    flexDirection: "row",
    backgroundColor: appColors.surface,
    borderWidth: 1,
    borderColor: appColors.border,
    borderRadius: 36,
    shadowColor: "#182d25",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: Platform.OS === "android" ? 8 : 0
  },
  indicator: {
    position: "absolute",
    left: 6,
    top: 6,
    bottom: 6,
    borderRadius: 28,
    backgroundColor: appColors.accentSoft
  },
  item: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  label: { color: appColors.muted, fontSize: 11, fontWeight: "600" },
  activeLabel: { color: appColors.accent }
});
