import {
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_IMAGE_EXTRACT_COUNT,
  MAX_IMAGE_EXTRACT_PAYLOAD_CHARS
} from "@linkdish/api-contracts";
import { File } from "expo-file-system";
import { manipulateAsync, SaveFormat, type Action } from "expo-image-manipulator";

import type { ExtractRecipeImage } from "@linkdish/api-contracts";
import type { ImagePickerAsset } from "expo-image-picker";

type PickedImage = Pick<ImagePickerAsset, "uri" | "width" | "height">;

// The deployed Vercel endpoint has a 4.5 MB body limit, below the API contract's limit.
// Keep room below that limit for JSON framing and request metadata.
const MAX_PICKED_IMAGE_PAYLOAD_CHARS = Math.min(MAX_IMAGE_EXTRACT_PAYLOAD_CHARS, 4_000_000);

const resizeActions = (asset: PickedImage, longestEdge: number): Action[] => {
  if (Math.max(asset.width, asset.height) <= longestEdge) return [];
  return [
    { resize: asset.width >= asset.height ? { width: longestEdge } : { height: longestEdge } }
  ];
};

const removeRenderedImage = (uri: string) => {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cache cleanup must not discard a usable recipe photo.
  }
};

/** Normalize HEIC/screenshots to JPEG and keep every selected page within the request budget. */
export const preparePickedImages = async (assets: PickedImage[]): Promise<ExtractRecipeImage[]> => {
  if (!assets.length || assets.length > MAX_IMAGE_EXTRACT_COUNT) {
    throw new Error("Choose between one and four recipe photos.");
  }
  // Reserve room for JSON framing, the source URL, and extraction metadata.
  const budget = Math.min(
    MAX_IMAGE_DATA_URL_CHARS,
    Math.floor((MAX_PICKED_IMAGE_PAYLOAD_CHARS - 10_000) / assets.length)
  );
  const images: ExtractRecipeImage[] = [];
  // Process sequentially so several full-resolution iPhone photos aren't decoded at once.
  for (const asset of assets) {
    let prepared: ExtractRecipeImage | undefined;
    for (const [longestEdge, compress] of [
      [2400, 0.8],
      [1800, 0.65],
      [1400, 0.5]
    ] as const) {
      const rendered = await manipulateAsync(asset.uri, resizeActions(asset, longestEdge), {
        base64: true,
        compress,
        format: SaveFormat.JPEG
      });
      try {
        const base64 = rendered.base64?.trim();
        const dataUrl = base64 ? `data:image/jpeg;base64,${base64}` : null;
        if (dataUrl && dataUrl.length <= budget) {
          prepared = { dataUrl, mimeType: "image/jpeg" };
          break;
        }
      } finally {
        if (rendered.uri !== asset.uri) removeRenderedImage(rendered.uri);
      }
    }
    if (!prepared) throw new Error("Recipe photos could not fit within the upload limit.");
    images.push(prepared);
  }
  return images;
};

/* The API stores a recipe picture at this size at most, so sending more only costs time. */
const RECIPE_PICTURE_EDGE = 1200;

/** A person's own picture for a recipe, as the data URL the API takes. */
export const prepareRecipePicture = async (asset: PickedImage): Promise<string> => {
  const rendered = await manipulateAsync(asset.uri, resizeActions(asset, RECIPE_PICTURE_EDGE), {
    base64: true,
    compress: 0.8,
    format: SaveFormat.JPEG
  });

  try {
    const base64 = rendered.base64?.trim();

    if (!base64) {
      throw new Error("The picture could not be read.");
    }

    return `data:image/jpeg;base64,${base64}`;
  } finally {
    if (rendered.uri !== asset.uri) removeRenderedImage(rendered.uri);
  }
};
