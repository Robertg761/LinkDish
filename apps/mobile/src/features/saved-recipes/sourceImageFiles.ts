import { Directory, File, Paths } from "expo-file-system";

import type { RecipeSourceImage } from "../recipe-results/types";

const SCAN_DIRECTORY_NAME = "recipe-scans";

const fileExtensions: Record<RecipeSourceImage["mimeType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

const dataUrlPattern = /^data:image\/[a-z+]+;base64,(?<payload>[\s\S]+)$/u;

const getScanDirectory = (): Directory => {
  const directory = new Directory(Paths.document, SCAN_DIRECTORY_NAME);

  if (!directory.exists) {
    directory.create({ idempotent: true, intermediates: true });
  }

  return directory;
};

const writeScanFile = (
  recordId: string,
  image: RecipeSourceImage,
  index: number
): RecipeSourceImage | null => {
  const payload = dataUrlPattern.exec(image.uri)?.groups?.payload;

  if (!payload) {
    return null;
  }

  const file = new File(
    getScanDirectory(),
    `${recordId}-${index}.${fileExtensions[image.mimeType]}`
  );

  file.create({ intermediates: true, overwrite: true });
  file.write(payload, { encoding: "base64" });

  return {
    mimeType: image.mimeType,
    uri: file.uri
  };
};

/**
 * Moves scan photos out of the saved-recipe record and onto the filesystem.
 *
 * Scans arrive from the importer as `data:image/...;base64,...` strings. Those
 * are megabytes each, and the cookbook is persisted as a single AsyncStorage
 * value, whose Android (SQLite) backing store rejects writes of a few MB. Keeping
 * the bytes on disk and only the URI in the record keeps the cookbook small
 * enough to persist reliably.
 *
 * A scan that cannot be written is dropped rather than inlined: losing one photo
 * is far better than losing the recipe (and every other recipe in the blob).
 */
export const persistRecipeSourceImages = async (
  recordId: string,
  images: RecipeSourceImage[] | undefined
): Promise<RecipeSourceImage[] | undefined> => {
  if (!images || images.length === 0) {
    return undefined;
  }

  const persistedImages = images
    .map((image, index) => {
      if (!image.uri.startsWith("data:")) {
        return image;
      }

      try {
        return writeScanFile(recordId, image, index);
      } catch (error) {
        console.warn("Failed to store a scanned recipe image.", error);
        return null;
      }
    })
    .filter((image): image is RecipeSourceImage => image !== null);

  return persistedImages.length > 0 ? persistedImages : undefined;
};
