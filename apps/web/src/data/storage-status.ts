import { useSyncExternalStore } from "react";

import {
  getLinkDishDbStatus,
  retryLinkDishWebDb,
  subscribeLinkDishDbStatus,
  type LinkDishDbStatus
} from "../storage/linkdish-db";

/**
 * The on-device database's connection state, for a banner such as "LinkDish was updated in
 * another tab — reload to keep going" (`outdated`) or "Close other LinkDish tabs to finish
 * updating" (`blocked`).
 */
export function useLinkDishDbStatus(): LinkDishDbStatus {
  return useSyncExternalStore(subscribeLinkDishDbStatus, getLinkDishDbStatus, getLinkDishDbStatus);
}

/** Tries to reopen storage after an error (never rejects). */
export async function retryLinkDishStorage(): Promise<boolean> {
  try {
    await retryLinkDishWebDb();
    return true;
  } catch {
    return false;
  }
}
