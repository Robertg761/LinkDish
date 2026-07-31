import type { ExtractRecipeImage } from "@linkdish/api-contracts";

export interface PendingImageImport {
  id: string;
  images: ExtractRecipeImage[];
  sourceUrl: string;
}

const pendingImageImports = new Map<string, PendingImageImport>();

const createImportId = (): string =>
  `image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const createPendingImageImport = (images: ExtractRecipeImage[]): PendingImageImport => {
  const id = createImportId();
  const pendingImport = {
    id,
    images,
    sourceUrl: `https://linkdish.app/image-imports/${id}`
  };

  pendingImageImports.set(id, pendingImport);
  return pendingImport;
};

export const getPendingImageImport = (id: string): PendingImageImport | undefined =>
  pendingImageImports.get(id);

export const removePendingImageImport = (id: string): void => {
  pendingImageImports.delete(id);
};

export const consumePendingImageImport = (id: string): PendingImageImport | undefined => {
  const pendingImport = getPendingImageImport(id);
  removePendingImageImport(id);
  return pendingImport;
};
