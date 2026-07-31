import * as Sharing from "expo-sharing";
import { Share } from "react-native";

import type { Recipe } from "@linkdish/recipe-domain";

const SHARE_CARD_DIALOG_TITLE = "Share LinkDish recipe card";
const LINKDISH_FOOTER = "Saved with LinkDish · linkdish.ca";

export const buildShareCardFallbackMessage = (recipe: Recipe): string =>
  [recipe.title, recipe.sourceUrl, LINKDISH_FOOTER]
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line))
    .join("\n");

export const shareRecipeCardImage = async (recipe: Recipe, shareUri: string): Promise<void> => {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shareUri, {
      dialogTitle: SHARE_CARD_DIALOG_TITLE,
      mimeType: "image/png"
    });
    return;
  }

  await Share.share(
    {
      message: buildShareCardFallbackMessage(recipe)
    },
    {
      dialogTitle: SHARE_CARD_DIALOG_TITLE
    }
  );
};
