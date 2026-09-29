import React, { useEffect } from "react";

import { useImportQueueBadge } from "../features/import-queue/use-import-queue-badge";

/** "3 imports waiting" (or "1 import needs a look") for the Add button's accessible name. */
export const describeImportQueue = (pending: number, failed: number): string => {
  const parts: string[] = [];

  if (pending > 0) {
    parts.push(`${pending} import${pending === 1 ? "" : "s"} waiting`);
  }

  if (failed > 0) {
    parts.push(failed === 1 ? "1 import needs a look" : `${failed} imports need a look`);
  }

  return parts.join(", ");
};

export interface ImportQueueCountProps {
  /** Receives the queue's spoken summary ("" when empty) for the Add button's accessible name. */
  onDescribe: (description: string) => void;
}

/**
 * The small count on the Add tab / rail button while links wait in the import queue. The shell
 * loads it beside the Cookbook (a boot-time lazy module, see vite.config.ts), so the queue store
 * and IndexedDB stay out of the entry script. It only reads the queue; it never processes it.
 */
export const ImportQueueCount: React.FC<ImportQueueCountProps> = ({ onDescribe }) => {
  const { count, failed, pending } = useImportQueueBadge();
  const description = describeImportQueue(pending, failed);

  useEffect(() => {
    onDescribe(description);
  }, [description, onDescribe]);

  if (count === 0) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className={`app-nav-badge num${failed > 0 ? " is-attention" : ""}`}
      data-testid="import-queue-badge"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
};
