import { randomBytes } from "node:crypto";

import {
  MAX_RECIPE_PHOTOS_PER_ACCOUNT,
  RECIPE_PHOTO_PATH_PREFIX
} from "../../../../../packages/api-contracts/src/index.js";
import { getUserById } from "../auth/auth-service.js";

import { countRecipePhotos, removeRecipePhoto, saveRecipePhoto } from "./recipe-photo-store.js";

import type { UploadRecipePhotoResponse } from "../../../../../packages/api-contracts/src/index.js";

/*
 * Pictures people choose for their own recipes. A recipe still holds a plain https URL (the one
 * GET /image/photos/<id>.webp answers), so syncing, sharing, the /image proxy and every installed
 * client treat it like a picture from a recipe site.
 *
 * Every upload is decoded and re-encoded: only a real image gets stored, upright, as WebP and
 * without its metadata (a phone photo's EXIF can hold where it was taken). The URL is public but
 * unguessable, like an unlisted link, because household members and the proxy read it unsigned.
 */

const MAX_PHOTO_EDGE = 1200;
const PHOTO_QUALITY = 78;
/* Far above a 1200px WebP of a real photo, so it only stops abuse. */
const MAX_STORED_PHOTO_BYTES = 700_000;

type SharpPipeline = {
  resize(options: {
    fit: "inside";
    height: number;
    width: number;
    withoutEnlargement: boolean;
  }): SharpPipeline;
  rotate(): SharpPipeline;
  toBuffer(options: {
    resolveWithObject: true;
  }): Promise<{ data: Buffer; info: { height: number; width: number } }>;
  webp(options: { quality: number }): SharpPipeline;
};

type SharpFactory = (input: Buffer) => SharpPipeline;

const loadSharp = async (): Promise<SharpFactory> => {
  const sharpModule = (await import("sharp")) as unknown as {
    default?: SharpFactory;
  } & SharpFactory;
  return sharpModule.default ?? sharpModule;
};

export class RecipePhotoError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "RecipePhotoError";
  }
}

const reencode = async (dataUrl: string) => {
  const sharp = await loadSharp();
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

  try {
    return await sharp(bytes)
      .rotate()
      .resize({
        fit: "inside",
        height: MAX_PHOTO_EDGE,
        width: MAX_PHOTO_EDGE,
        withoutEnlargement: true
      })
      .webp({ quality: PHOTO_QUALITY })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new RecipePhotoError("That file couldn't be read as a picture.");
  }
};

const overLimitError = () =>
  new RecipePhotoError(
    `You've reached the limit of ${MAX_RECIPE_PHOTOS_PER_ACCOUNT} uploaded pictures.`,
    409
  );

/** Stores a picture for `userId`, within the account's allowance. */
export const storeRecipePhoto = async (
  userId: string,
  dataUrl: string
): Promise<UploadRecipePhotoResponse> => {
  // Spares the re-encoding. The count that counts is the one taken as the picture is stored.
  if ((await countRecipePhotos(userId)) >= MAX_RECIPE_PHOTOS_PER_ACCOUNT) {
    throw overLimitError();
  }

  const { data, info } = await reencode(dataUrl);

  if (data.length > MAX_STORED_PHOTO_BYTES) {
    throw new RecipePhotoError("That picture is too large. Try a smaller one.", 413);
  }

  const id = randomBytes(16).toString("hex");
  const count = await saveRecipePhoto(userId, id, data);

  // Uploads racing past the check above each see the count that includes them.
  if (count > MAX_RECIPE_PHOTOS_PER_ACCOUNT) {
    await removeRecipePhoto(userId, id);
    throw overLimitError();
  }

  /*
   * An upload can outlast the account it started under. Account deletion marks the account and
   * then removes its pictures, so a picture stored before that removal is taken with the rest,
   * and one stored after it sees the mark here.
   */
  if ((await getUserById(userId))?.deletedAt) {
    await removeRecipePhoto(userId, id);
    throw new RecipePhotoError("Sign in is required.", 401);
  }

  return {
    height: info.height,
    path: `${RECIPE_PHOTO_PATH_PREFIX}${id}.webp`,
    width: info.width
  };
};
