import type { DevicePage } from "../../services/device-page";

/**
 * A page the person opened in the in-app browser view and saved, held in memory while the
 * recipe screen reads it, the way scans and pasted text are held.
 */
export interface PendingPageImport {
  id: string;
  devicePage: DevicePage;
  /** The page's address: the recipe's source and the route's key. */
  url: string;
}

const pendingPageImports = new Map<string, PendingPageImport>();

export const createPendingPageImport = (url: string, devicePage: DevicePage): PendingPageImport => {
  const id = `page-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const pendingImport: PendingPageImport = { id, devicePage, url };

  pendingPageImports.set(id, pendingImport);
  return pendingImport;
};

export const getPendingPageImport = (id: string): PendingPageImport | undefined =>
  pendingPageImports.get(id);

export const removePendingPageImport = (id: string): void => {
  pendingPageImports.delete(id);
};
