import { useEffect, useState } from "react";

import {
  getPendingImageImport,
  removePendingImageImport,
  type PendingImageImport
} from "./pendingImageImports";
import {
  getPendingTextImport,
  removePendingTextImport,
  type PendingTextImport
} from "./textImport";

export type PendingImageImportStatus = "none" | "ready" | "missing";

export interface PendingImportState<Pending> {
  pendingImport: Pending | undefined;
  /**
   * `ready`: the import is in memory and can be extracted. `missing`: the route asks for one
   * that is gone, which happens when Android restores /recipe after killing the process
   * (pending imports only live in memory). `none`: this is not such an import.
   */
  status: PendingImageImportStatus;
}

export type PendingImageImportState = PendingImportState<PendingImageImport>;

/**
 * Reads a pending import (a scan, or pasted text) for an import route. It is looked up during
 * the first render (a non-destructive peek, safe under StrictMode) so the screen never flashes an
 * empty "no link" state, and it is released from the in-memory map after mounting so the payload
 * does not stay around.
 */
const usePendingImport = <Pending>(
  importId: string | undefined,
  get: (id: string) => Pending | undefined,
  remove: (id: string) => void
): PendingImportState<Pending> => {
  const [state, setState] = useState<{
    id: string | undefined;
    pendingImport: Pending | undefined;
  }>(() => ({
    id: importId,
    pendingImport: importId ? get(importId) : undefined
  }));

  useEffect(() => {
    if (!importId) {
      return;
    }

    const pendingImport = get(importId);

    setState((current) =>
      current.id === importId && current.pendingImport ? current : { id: importId, pendingImport }
    );
    remove(importId);
  }, [get, importId, remove]);

  if (!importId) {
    return { pendingImport: undefined, status: "none" };
  }

  // The route changed to another import and the effect has not stored it yet: peek again.
  const pendingImport = state.id === importId ? state.pendingImport : get(importId);

  return pendingImport ? { pendingImport, status: "ready" } : { pendingImport, status: "missing" };
};

export const usePendingImageImport = (imageImportId: string | undefined): PendingImageImportState =>
  usePendingImport(imageImportId, getPendingImageImport, removePendingImageImport);

export const usePendingTextImport = (
  textImportId: string | undefined
): PendingImportState<PendingTextImport> =>
  usePendingImport(textImportId, getPendingTextImport, removePendingTextImport);
