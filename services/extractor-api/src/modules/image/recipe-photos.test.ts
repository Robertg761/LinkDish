import { randomUUID } from "node:crypto";

import sharpModule from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RECIPE_PHOTOS_PER_ACCOUNT } from "../../../../../packages/api-contracts/src/index.js";
import * as store from "../storage/upstash-store.js";

import {
  countRecipePhotos,
  deleteRecipePhotosForUser,
  readRecipePhoto,
  saveRecipePhoto
} from "./recipe-photo-store.js";
import { RecipePhotoError, storeRecipePhoto } from "./recipe-photos.js";

const auth = vi.hoisted(() => ({ getUserById: vi.fn() }));

vi.mock("../auth/auth-service.js", () => ({ getUserById: auth.getUserById }));
vi.mock("../storage/upstash-store.js", async (load) => ({
  ...(await load<Record<string, unknown>>())
}));

/* What these tests use of sharp, beyond the little the API's own type shim declares. */
interface TestImage {
  jpeg(): TestImage;
  metadata(): Promise<{ exif?: Buffer; format?: string; height?: number; width?: number }>;
  toBuffer(): Promise<Buffer>;
  withExif(exif: Record<string, Record<string, string>>): TestImage;
  withMetadata(metadata: { orientation: number }): TestImage;
}

const sharp = sharpModule as unknown as (
  input: Buffer | { create: { background: string; channels: 3; height: number; width: number } }
) => TestImage;

const fileOf = (path: string): string => path.split("/").at(-1) ?? "";

const jpegDataUrl = async (
  width: number,
  height: number,
  options: { exif?: Record<string, Record<string, string>>; orientation?: number } = {}
): Promise<string> => {
  let image = sharp({
    create: { background: "#c0392b", channels: 3, height, width }
  }).jpeg();

  if (options.exif) {
    image = image.withExif(options.exif);
  }

  if (options.orientation) {
    image = image.withMetadata({ orientation: options.orientation });
  }

  return `data:image/jpeg;base64,${(await image.toBuffer()).toString("base64")}`;
};

describe("recipe photos", () => {
  /* The in-memory store outlives a test: a new account each time keeps them apart. */
  let me: string;
  let someoneElse: string;

  beforeEach(() => {
    me = randomUUID();
    someoneElse = randomUUID();
    auth.getUserById.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores an upload as WebP at an unguessable path and serves it back", async () => {
    const stored = await storeRecipePhoto(me, await jpegDataUrl(640, 480));

    expect(stored).toMatchObject({ height: 480, width: 640 });
    expect(stored.path).toMatch(/^\/image\/photos\/[a-f0-9]{32}\.webp$/u);

    const photo = await readRecipePhoto(fileOf(stored.path));

    expect(await sharp(photo ?? Buffer.alloc(0)).metadata()).toMatchObject({
      format: "webp",
      height: 480,
      width: 640
    });
  });

  it("caps the long edge at 1200px without enlarging small pictures", async () => {
    const large = await storeRecipePhoto(me, await jpegDataUrl(3000, 1500));
    const small = await storeRecipePhoto(me, await jpegDataUrl(300, 200));

    expect(large).toMatchObject({ height: 600, width: 1200 });
    expect(small).toMatchObject({ height: 200, width: 300 });
  });

  it("drops the photo's metadata, so where it was taken doesn't travel with it", async () => {
    const dataUrl = await jpegDataUrl(320, 240, {
      exif: { IFD3: { GPSLatitude: "43/1 39/1 0/1", GPSLatitudeRef: "N" } }
    });
    const source = await sharp(
      Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")
    ).metadata();

    expect(source.exif).toBeDefined();

    const stored = await storeRecipePhoto(me, dataUrl);
    const photo = await readRecipePhoto(fileOf(stored.path));

    expect((await sharp(photo ?? Buffer.alloc(0)).metadata()).exif).toBeUndefined();
  });

  it("turns a sideways phone photo upright", async () => {
    const stored = await storeRecipePhoto(me, await jpegDataUrl(400, 200, { orientation: 6 }));

    expect(stored).toMatchObject({ height: 400, width: 200 });
  });

  it("refuses bytes that aren't a picture and stores nothing", async () => {
    const notAPicture = `data:image/jpeg;base64,${Buffer.from("<script>").toString("base64")}`;

    await expect(storeRecipePhoto(me, notAPicture)).rejects.toBeInstanceOf(RecipePhotoError);
    expect(await countRecipePhotos(me)).toBe(0);
  });

  it("stops at the account's allowance, for that account only", async () => {
    const bytes = Buffer.from("stored");

    for (let index = 0; index < MAX_RECIPE_PHOTOS_PER_ACCOUNT; index += 1) {
      await saveRecipePhoto(me, index.toString(16).padStart(32, "0"), bytes);
    }

    const dataUrl = await jpegDataUrl(64, 64);

    await expect(storeRecipePhoto(me, dataUrl)).rejects.toMatchObject({ statusCode: 409 });
    await expect(storeRecipePhoto(someoneElse, dataUrl)).resolves.toBeDefined();
  });

  it("takes a picture back when uploads race past the allowance", async () => {
    const bytes = Buffer.from("stored");

    for (let index = 0; index < MAX_RECIPE_PHOTOS_PER_ACCOUNT - 1; index += 1) {
      await saveRecipePhoto(me, index.toString(16).padStart(32, "0"), bytes);
    }

    const dataUrl = await jpegDataUrl(64, 64);
    const uploads = await Promise.allSettled([
      storeRecipePhoto(me, dataUrl),
      storeRecipePhoto(me, dataUrl),
      storeRecipePhoto(me, dataUrl)
    ]);

    expect(await countRecipePhotos(me)).toBeLessThanOrEqual(MAX_RECIPE_PHOTOS_PER_ACCOUNT);
    expect(uploads.some((upload) => upload.status === "rejected")).toBe(true);
  });

  it("stores a picture and its place in the index together, or not at all", async () => {
    const transaction = vi
      .spyOn(store, "runStoreTransaction")
      .mockResolvedValueOnce([{ result: "OK" }, { error: "out of memory" }, { result: 0 }]);

    await expect(saveRecipePhoto(me, "a".repeat(32), Buffer.from("stored"))).rejects.toBeInstanceOf(
      store.KeyValueStoreUnavailableError
    );

    expect(transaction.mock.calls[0]?.[0].map(([command]) => command)).toEqual([
      "SET",
      "SADD",
      "SCARD"
    ]);
  });

  it("takes back an upload that finished after its account was deleted", async () => {
    auth.getUserById.mockResolvedValue({ deletedAt: "2026-11-05T00:00:00.000Z" });

    await expect(storeRecipePhoto(me, await jpegDataUrl(64, 64))).rejects.toMatchObject({
      statusCode: 401
    });

    expect(await countRecipePhotos(me)).toBe(0);
  });

  it("answers null for a name that isn't a stored picture", async () => {
    expect(await readRecipePhoto(`${"a".repeat(32)}.webp`)).toBeNull();

    for (const file of ["", "x.webp", `${"a".repeat(32)}.png`, `../${"a".repeat(32)}.webp`]) {
      expect(await readRecipePhoto(file)).toBeNull();
    }
  });

  it("removes an account's pictures and leaves everyone else's", async () => {
    const dataUrl = await jpegDataUrl(64, 64);
    const mine = await storeRecipePhoto(me, dataUrl);
    const theirs = await storeRecipePhoto(someoneElse, dataUrl);

    await deleteRecipePhotosForUser(me);

    expect(await readRecipePhoto(fileOf(mine.path))).toBeNull();
    expect(await store.getStoreSetMembers(`linkdish:recipe-photos:v1:${me}`)).toEqual([]);
    expect(await readRecipePhoto(fileOf(theirs.path))).not.toBeNull();
  });
});
