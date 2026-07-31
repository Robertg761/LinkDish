import { AppText } from "@linkdish/ui";
import { decodeHtmlEntities } from "@linkdish/utils";
import React, { forwardRef } from "react";
import { Image, StyleSheet, View } from "react-native";

import { buildProxiedRecipeImageUrl } from "../../lib/recipeImage";
import { appColors } from "../../theme/tokens";

import type { Recipe } from "@linkdish/recipe-domain";

const decodeDisplayText = (value: string) => decodeHtmlEntities(value).replace(/\u00a0/gu, " ");

export const ShareCard = forwardRef<
  View,
  {
    recipe: Recipe;
    sourceLabel: string;
  }
>(({ recipe, sourceLabel }, ref) => {
  const imageUrl = buildProxiedRecipeImageUrl(recipe.image, 480);

  return (
    <View collapsable={false} ref={ref} style={styles.card}>
      <View style={styles.border}>
        <View style={[styles.content, imageUrl && styles.contentWithImage]}>
          {imageUrl ? (
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="cover"
              source={{ uri: imageUrl }}
              style={styles.image}
            />
          ) : null}
          <View style={styles.textContent}>
            <AppText style={styles.eyebrow}>LINKDISH</AppText>
            <View style={[styles.titleBlock, imageUrl && styles.titleBlockWithImage]}>
              <AppText numberOfLines={3} style={styles.title} variant="headline">
                {decodeDisplayText(recipe.title)}
              </AppText>
              <AppText numberOfLines={1} style={styles.source}>
                {sourceLabel}
              </AppText>
            </View>
            <AppText italic style={styles.tagline}>
              Get cooking.
            </AppText>
            <AppText numberOfLines={1} style={styles.footer}>
              Made with LinkDish · linkdish.ca
            </AppText>
          </View>
        </View>
      </View>
    </View>
  );
});

ShareCard.displayName = "ShareCard";

const styles = StyleSheet.create({
  border: {
    borderColor: appColors.accent,
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    padding: 18
  },
  card: {
    backgroundColor: appColors.background,
    height: 189,
    padding: 10,
    width: 360
  },
  content: {
    flex: 1
  },
  contentWithImage: {
    flexDirection: "row",
    gap: 16
  },
  eyebrow: {
    color: appColors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.4,
    lineHeight: 16
  },
  footer: {
    bottom: 0,
    color: appColors.muted,
    fontSize: 10,
    fontWeight: "600",
    left: 0,
    lineHeight: 13,
    position: "absolute"
  },
  image: {
    backgroundColor: appColors.accentSoft,
    borderRadius: 16,
    height: "100%",
    width: 98
  },
  source: {
    color: appColors.muted,
    fontSize: 14,
    lineHeight: 18,
    marginTop: 8
  },
  tagline: {
    bottom: 16,
    color: appColors.accent,
    fontSize: 19,
    lineHeight: 24,
    position: "absolute",
    right: 0
  },
  title: {
    color: appColors.text,
    fontSize: 31,
    lineHeight: 36
  },
  titleBlock: {
    marginTop: 28,
    maxWidth: 278
  },
  titleBlockWithImage: {
    marginTop: 22,
    maxWidth: 180
  },
  textContent: {
    flex: 1,
    minWidth: 0
  }
});
