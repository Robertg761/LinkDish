import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

/** When this browser last downloaded a full backup (ISO timestamp). */
export const LAST_BACKUP_STORAGE_KEY = "linkdish:web:last-backup:v1";

export const readLastBackupAt = (): string | null => {
  const value = safeGetItem(LAST_BACKUP_STORAGE_KEY);
  return value && Number.isFinite(Date.parse(value)) ? value : null;
};

export const recordBackupDownloaded = (at: Date): void => {
  safeSetItem(LAST_BACKUP_STORAGE_KEY, at.toISOString());
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "today", "yesterday", "3 days ago", "on 4 March 2026". */
export const describeLastBackup = (iso: string, now: Date = new Date()): string => {
  const then = new Date(iso);
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS);

  if (days <= 0) {
    return "today";
  }

  if (days === 1) {
    return "yesterday";
  }

  if (days < 30) {
    return `${days} days ago`;
  }

  return `on ${then.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}`;
};
