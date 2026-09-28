import { useMemo } from "react";

import { useImportQueue } from "../../data/import-queue-store";

export interface ImportQueueBadge {
  /** Links waiting or being imported right now. */
  pending: number;
  /** Imports that need attention (Retry or Remove). */
  failed: number;
  /** pending + failed: the number to show on an "Add" badge. */
  count: number;
}

/**
 * A small count for navigation badges ("3 imports waiting"). Safe to use on any screen: it
 * only reads the queue, it doesn't process it.
 */
export function useImportQueueBadge(): ImportQueueBadge {
  const { failedCount, pendingCount } = useImportQueue();

  return useMemo(
    () => ({ count: pendingCount + failedCount, failed: failedCount, pending: pendingCount }),
    [failedCount, pendingCount]
  );
}
