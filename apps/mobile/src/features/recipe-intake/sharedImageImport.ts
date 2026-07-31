import { File } from "expo-file-system";
import { manipulateAsync, SaveFormat, type Action, type ImageResult } from "expo-image-manipulator";

import type { ExtractRecipeImage } from "@linkdish/api-contracts";

export const MAX_SHARED_IMAGE_DATA_URL_LENGTH = 4_500_000;
const RETRY_IMAGE_WIDTH = 1_800;

const getDataUrl = (result: ImageResult): string | null => {
  const base64 = result.base64?.trim();
  return base64 ? `data:image/jpeg;base64,${base64}` : null;
};

const deleteTemporaryFile = (uri: string | undefined): void => {
  if (!uri) {
    return;
  }

  try {
    const file = new File(uri);

    if (file.exists) {
      file.delete();
    }
  } catch {
    // Cache cleanup should never hide a usable shared image.
  }
};

const renderSharedImage = (uri: string, actions: Action[], compress: number) =>
  manipulateAsync(uri, actions, {
    base64: true,
    compress,
    format: SaveFormat.JPEG
  });

const getSourceMimeType = (sourceMimeType: string | undefined): string =>
  sourceMimeType && /^image\/[a-z0-9.+-]+$/iu.test(sourceMimeType) ? sourceMimeType : "image/jpeg";

export const prepareSharedImageImport = async (
  sourceUri: string,
  sourceMimeType?: string
): Promise<ExtractRecipeImage> => {
  if (!sourceUri.startsWith("content://") && !sourceUri.startsWith("file://")) {
    throw new Error("Unsupported shared image location.");
  }

  let renderedImageUri: string | undefined;

  try {
    const sourceBase64 = (await new File(sourceUri).base64()).trim();

    if (!sourceBase64) {
      throw new Error("Shared image is empty.");
    }

    const sourceDataUrl = `data:${getSourceMimeType(sourceMimeType)};base64,${sourceBase64}`;
    let result = await renderSharedImage(sourceDataUrl, [], 0.82);
    renderedImageUri = result.uri;
    let dataUrl = getDataUrl(result);

    if (!dataUrl || dataUrl.length > MAX_SHARED_IMAGE_DATA_URL_LENGTH) {
      deleteTemporaryFile(renderedImageUri);
      const resizeActions: Action[] =
        result.width > RETRY_IMAGE_WIDTH ? [{ resize: { width: RETRY_IMAGE_WIDTH } }] : [];
      result = await renderSharedImage(sourceDataUrl, resizeActions, 0.62);
      renderedImageUri = result.uri;
      dataUrl = getDataUrl(result);
    }

    if (!dataUrl || dataUrl.length > MAX_SHARED_IMAGE_DATA_URL_LENGTH) {
      throw new Error("Shared image is too large to import.");
    }

    return {
      dataUrl,
      mimeType: "image/jpeg"
    };
  } finally {
    deleteTemporaryFile(renderedImageUri);
  }
};
