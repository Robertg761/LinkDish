import { useEffect, useState } from "react";

import {
  getPendingImageImport,
  removePendingImageImport,
  type PendingImageImport
} from "./pendingImageImports";

export type PendingImageImportStatus = "none" | "ready" | "missing";

export interface PendingImageImportState {
  pendingImport: PendingImageImport | undefined;
  /**
   * `ready`: the scan is in memory and can be extracted. `missing`: the route asks for a scan
   * that is gone, which happens when Android restores /recipe after killing the process
   * (pending scans only live in memory). `none`: this is not an image import.
   */
  status: PendingImageImportStatus;
}

/**
 * Reads the pending scan for an image-import route. The scan is looked up during the first
 * render (a non-destructive peek, safe under StrictMode) so the screen never flashes an empty
 * "no link" state, and it is released from the in-memory map after mounting so the base64
 * payload does not stay around.
 */
export const usePendingImageImport = (
  imageImportId: string | undefined
): PendingImageImportState => {
  const [state, setState] = useState<{
    id: string | undefined;
    pendingImport: PendingImageImport | undefined;
  }>(() => ({
    id: imageImportId,
    pendingImport: imageImportId ? getPendingImageImport(imageImportId) : undefined
  }));

  useEffect(() => {
    if (!imageImportId) {
      return;
    }

    const pendingImport = getPendingImageImport(imageImportId);

    setState((current) =>
      current.id === imageImportId && current.pendingImport
        ? current
        : { id: imageImportId, pendingImport }
    );
    removePendingImageImport(imageImportId);
  }, [imageImportId]);

  if (!imageImportId) {
    return { pendingImport: undefined, status: "none" };
  }

  // The route changed to another scan and the effect has not stored it yet: peek again.
  const pendingImport =
    state.id === imageImportId ? state.pendingImport : getPendingImageImport(imageImportId);

  return pendingImport ? { pendingImport, status: "ready" } : { pendingImport, status: "missing" };
};
