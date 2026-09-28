import type { ExtractRecipeImage } from "@linkdish/api-contracts";

/**
 * Recipe photos are shrunk in the browser before upload: a 12-megapixel phone photo becomes a
 * ~1600px JPEG of a few hundred kilobytes, which reads just as well, uploads in a blink on a
 * kitchen's patchy Wi-Fi and stays far below the API's 4.5M-character-per-image and
 * 8M-character-per-request limits.
 */

export const MAX_PHOTO_EDGE = 1600;
export const PHOTO_JPEG_QUALITY = 0.8;
/** Second pass for unusually detailed photos (keeps four photos well under 8M characters). */
const SMALLER_PHOTO_EDGE = 1200;
const SMALLER_PHOTO_QUALITY = 0.7;
/** Per-photo budget in data-URL characters: 4 × 1.9M stays under the 8M request limit. */
export const MAX_PHOTO_DATA_URL_CHARS = 1_900_000;

export type PhotoPrepErrorCode = "heic_unsupported" | "unreadable" | "not_image" | "too_large";

export class PhotoPrepError extends Error {
  public constructor(
    public readonly code: PhotoPrepErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PhotoPrepError";
  }
}

export const PHOTO_PREP_MESSAGES: Record<PhotoPrepErrorCode, string> = {
  heic_unsupported:
    "This browser can't open HEIC photos. Take a screenshot of the photo, or save it as a JPEG, and try again.",
  not_image: "That file isn't a photo. Choose a JPEG, PNG or WebP picture of the recipe.",
  too_large:
    "That photo is too detailed to send, even after shrinking. Try cropping it to just the recipe.",
  unreadable: "We couldn't open that photo. Try another one, or take a new picture."
};

export interface PreparedPhoto extends ExtractRecipeImage {
  width: number;
  height: number;
}

export const isHeicFile = (file: Pick<File, "name" | "type">): boolean =>
  /^image\/hei[cf](?:-sequence)?$/iu.test(file.type) || /\.hei[cf]$/iu.test(file.name);

const isImageFile = (file: Pick<File, "name" | "type">): boolean =>
  file.type.startsWith("image/") ||
  isHeicFile(file) ||
  (file.type === "" && /\.(?:jpe?g|png|webp|gif|bmp|avif)$/iu.test(file.name));

/** The size that fits inside `maxEdge` on the long side, never upscaled. */
export const scaleToFit = (
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } => {
  const longEdge = Math.max(width, height);

  if (!Number.isFinite(longEdge) || longEdge <= 0) {
    return { height: 0, width: 0 };
  }

  if (longEdge <= maxEdge) {
    return { height: Math.round(height), width: Math.round(width) };
  }

  const ratio = maxEdge / longEdge;
  return {
    height: Math.max(1, Math.round(height * ratio)),
    width: Math.max(1, Math.round(width * ratio))
  };
};

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

const decodeWithImageElement = (file: Blob): Promise<DecodedImage> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () =>
      resolve({
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(url),
        source: image,
        width: image.naturalWidth
      });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The image could not be decoded."));
    };
    image.src = url;
  });

const decodeImage = async (file: Blob): Promise<DecodedImage> => {
  if (typeof createImageBitmap === "function") {
    try {
      // Browsers apply the photo's EXIF orientation here, so sideways phone shots come out upright.
      const bitmap = await createImageBitmap(file);
      return {
        height: bitmap.height,
        release: () => bitmap.close(),
        source: bitmap,
        width: bitmap.width
      };
    } catch {
      // Some browsers decode formats in <img> that createImageBitmap refuses; try that next.
    }
  }

  return decodeWithImageElement(file);
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The photo could not be read."));
    reader.onerror = () => reject(reader.error ?? new Error("The photo could not be read."));
    reader.readAsDataURL(blob);
  });

/** Draws onto a white page (transparent PNG screenshots would turn black as JPEG). */
const paint = (
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  image: DecodedImage,
  width: number,
  height: number
) => {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image.source, 0, 0, width, height);
};

const encodeJpeg = async (
  image: DecodedImage,
  width: number,
  height: number,
  quality: number
): Promise<string> => {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");

    if (context) {
      paint(context, image, width, height);
      return blobToDataUrl(await canvas.convertToBlob({ quality, type: "image/jpeg" }));
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas is unavailable.");
  }

  paint(context, image, width, height);
  return canvas.toDataURL("image/jpeg", quality);
};

const isJpegDataUrl = (value: string): boolean => /^data:image\/jpe?g;base64,/iu.test(value);

/**
 * Decodes a photo, shrinks it to {@link MAX_PHOTO_EDGE}px on the long side and re-encodes it as
 * a JPEG at {@link PHOTO_JPEG_QUALITY}. Throws {@link PhotoPrepError} with a friendly message.
 */
export async function prepareRecipePhoto(file: File): Promise<PreparedPhoto> {
  if (!isImageFile(file)) {
    throw new PhotoPrepError("not_image", PHOTO_PREP_MESSAGES.not_image);
  }

  let image: DecodedImage;

  try {
    image = await decodeImage(file);
  } catch {
    const code = isHeicFile(file) ? "heic_unsupported" : "unreadable";
    throw new PhotoPrepError(code, PHOTO_PREP_MESSAGES[code]);
  }

  try {
    if (!image.width || !image.height) {
      throw new PhotoPrepError("unreadable", PHOTO_PREP_MESSAGES.unreadable);
    }

    let size = scaleToFit(image.width, image.height, MAX_PHOTO_EDGE);
    let dataUrl = await encodeJpeg(image, size.width, size.height, PHOTO_JPEG_QUALITY);

    if (dataUrl.length > MAX_PHOTO_DATA_URL_CHARS) {
      size = scaleToFit(image.width, image.height, SMALLER_PHOTO_EDGE);
      dataUrl = await encodeJpeg(image, size.width, size.height, SMALLER_PHOTO_QUALITY);
    }

    if (!isJpegDataUrl(dataUrl)) {
      throw new PhotoPrepError("unreadable", PHOTO_PREP_MESSAGES.unreadable);
    }

    if (dataUrl.length > MAX_PHOTO_DATA_URL_CHARS) {
      throw new PhotoPrepError("too_large", PHOTO_PREP_MESSAGES.too_large);
    }

    return { dataUrl, height: size.height, mimeType: "image/jpeg", width: size.width };
  } catch (error) {
    if (error instanceof PhotoPrepError) {
      throw error;
    }

    throw new PhotoPrepError("unreadable", PHOTO_PREP_MESSAGES.unreadable);
  } finally {
    image.release();
  }
}
