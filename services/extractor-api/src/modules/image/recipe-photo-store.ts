import {
  addStoreSetMembers,
  deleteStoreKeys,
  getStoreSetMembers,
  getStoreString,
  setStoreString
} from "../storage/upstash-store.js";

/*
 * Where uploaded recipe pictures live (see recipe-photos.ts). Apart from the image processing, so
 * that deleting an account doesn't bring sharp into the household function.
 */

const DELETE_KEYS_CHUNK_SIZE = 500;
const PHOTO_FILE_PATTERN = /^([a-f0-9]{32})\.webp$/u;

const photoKey = (id: string): string => `linkdish:recipe-photo:v1:${id}`;
const accountPhotosKey = (userId: string): string => `linkdish:recipe-photos:v1:${userId}`;

export const countRecipePhotos = async (userId: string): Promise<number> =>
  (await getStoreSetMembers(accountPhotosKey(userId))).length;

export const saveRecipePhoto = async (userId: string, id: string, bytes: Buffer): Promise<void> => {
  await setStoreString(photoKey(id), bytes.toString("base64"));
  await addStoreSetMembers(accountPhotosKey(userId), id);
};

/** The picture a `<id>.webp` file name stands for; null when there is none. */
export const readRecipePhoto = async (file: string): Promise<Buffer | null> => {
  const id = file.match(PHOTO_FILE_PATTERN)?.[1];
  const stored = id ? await getStoreString(photoKey(id)) : null;

  return stored ? Buffer.from(stored, "base64") : null;
};

/** Removes every picture the account uploaded (account deletion). */
export const deleteRecipePhotosForUser = async (userId: string): Promise<void> => {
  const keys = (await getStoreSetMembers(accountPhotosKey(userId))).map(photoKey);

  for (let start = 0; start < keys.length; start += DELETE_KEYS_CHUNK_SIZE) {
    await deleteStoreKeys(...keys.slice(start, start + DELETE_KEYS_CHUNK_SIZE));
  }

  await deleteStoreKeys(accountPhotosKey(userId));
};
