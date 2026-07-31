import { decodeHtmlEntities } from "@linkdish/utils";

import { mobileEnv } from "../config/env";

import type { RecipeImage } from "@linkdish/recipe-domain";

export type RecipeImageProxyWidth = 96 | 480 | 1200;

export const buildProxiedRecipeImageUrl = (
  image: RecipeImage | null | undefined,
  width: RecipeImageProxyWidth
): string | null => {
  if (!image?.url) {
    return null;
  }

  const baseUrl = `${mobileEnv.apiBaseUrl.replace(/\/+$/u, "")}/image`;
  const proxiedUrl = new URL(baseUrl);
  proxiedUrl.searchParams.set("url", image.url);
  proxiedUrl.searchParams.set("w", String(width));

  return proxiedUrl.toString();
};

export const getRecipeMonogram = (title: string): string => {
  const decodedTitle = decodeHtmlEntities(title)
    .replace(/\u00a0/gu, " ")
    .trim();
  const firstAlphanumeric = decodedTitle.match(/[\p{L}\p{N}]/u)?.[0];

  return firstAlphanumeric ? firstAlphanumeric.toLocaleUpperCase() : "L";
};
