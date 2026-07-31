import { apiBaseUrl } from "../api/client";

import type { RecipeImage } from "@linkdish/recipe-domain";

export type RecipeImageWidth = 96 | 480 | 1200;

const normalizeApiBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

export const buildRecipeImageUrl = (
  image: RecipeImage | null | undefined,
  width: RecipeImageWidth,
  baseUrl = apiBaseUrl
): string | null => {
  if (!image?.url) {
    return null;
  }

  const params = new URLSearchParams({
    url: image.url,
    w: String(width)
  });

  return `${normalizeApiBase(baseUrl)}/image?${params.toString()}`;
};

export const getRecipeMonogram = (title: string | null | undefined): string => {
  const trimmed = title?.trim() ?? "";

  if (!trimmed) {
    return "L";
  }

  return Array.from(trimmed)[0]?.toLocaleUpperCase() ?? "L";
};

export const getRecipeImageOrNull = (image: RecipeImage | null | undefined): RecipeImage | null =>
  image ?? null;
