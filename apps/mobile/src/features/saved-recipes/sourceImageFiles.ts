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
  index: number,
  version: string | undefined
): RecipeSourceImage | null => {
  const payload = dataUrlPattern.exec(image.uri)?.groups?.payload;

  if (!payload) {
    return null;
  }

  const file = new File(
    getScanDirectory(),
    `${recordId}-${version ? `${version}-` : ""}${index}.${fileExtensions[image.mimeType]}`
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
 *
 * With a `version`, the files get names of their own, so the ones a stored record (or a clone
 * of it) already uses are never overwritten before the cookbook that points at the new ones is
 * written.
 */
export const persistRecipeSourceImages = (
  recordId: string,
  images: RecipeSourceImage[] | undefined,
  options: { version?: string | undefined } = {}
): RecipeSourceImage[] | undefined => {
  if (!images || images.length === 0) {
    return undefined;
  }

  const persistedImages = images
    .map((image, index) => {
      if (!image.uri.startsWith("data:")) {
        return image;
      }

      try {
        return writeScanFile(recordId, image, index, options.version);
      } catch (error) {
        console.warn("Failed to store a scanned recipe image.", error);
        return null;
      }
    })
    .filter((image): image is RecipeSourceImage => image !== null);

  return persistedImages.length > 0 ? persistedImages : undefined;
};

/**
 * Deletes scan files that no saved recipe uses anymore (see getOrphanedSourceImageUris, which
 * keeps files a clone still shares). Only files inside documents/recipe-scans are touched; a
 * file that is already gone or cannot be deleted is skipped.
 */
export const deleteRecipeSourceImageFiles = (uris: readonly string[]): number => {
  let deleted = 0;

  for (const uri of uris) {
    if (!uri.startsWith("file:") || !uri.includes(`/${SCAN_DIRECTORY_NAME}/`)) {
      continue;
    }

    try {
      const file = new File(uri);

      if (file.exists) {
        file.delete();
        deleted += 1;
      }
    } catch (error) {
      console.warn("Failed to delete a scanned recipe image.", error);
    }
  }

  return deleted;
};

/** A fresh name part for one save's scan files (see persistRecipeSourceImages). */
export const createScanVersion = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
