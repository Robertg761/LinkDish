/**
 * The browser's storage manager: how much LinkDish uses on this device and whether the browser
 * promised to keep it ("persistent storage"). Every call feature-detects and never throws.
 */

export interface StorageEstimateInfo {
  supported: boolean;
  usage: number | null;
  quota: number | null;
}

export type PersistenceState = "unsupported" | "persisted" | "not_persisted";

export type PersistRequestResult = "granted" | "denied" | "unsupported";

const storageManager = (): StorageManager | null =>
  typeof navigator !== "undefined" && navigator.storage ? navigator.storage : null;

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const readStorageEstimate = async (): Promise<StorageEstimateInfo> => {
  const manager = storageManager();

  if (!manager || typeof manager.estimate !== "function") {
    return { supported: false, usage: null, quota: null };
  }

  try {
    const estimate = await manager.estimate();
    return {
      supported: true,
      usage: finiteOrNull(estimate.usage),
      quota: finiteOrNull(estimate.quota)
    };
  } catch {
    return { supported: false, usage: null, quota: null };
  }
};

export const readPersistence = async (): Promise<PersistenceState> => {
  const manager = storageManager();

  if (
    !manager ||
    typeof manager.persisted !== "function" ||
    typeof manager.persist !== "function"
  ) {
    return "unsupported";
  }

  try {
    return (await manager.persisted()) ? "persisted" : "not_persisted";
  } catch {
    return "unsupported";
  }
};

/** Asks the browser to keep LinkDish's data even when the device runs low on space. */
export const requestPersistence = async (): Promise<PersistRequestResult> => {
  const manager = storageManager();

  if (!manager || typeof manager.persist !== "function") {
    return "unsupported";
  }

  try {
    return (await manager.persist()) ? "granted" : "denied";
  } catch {
    return "denied";
  }
};

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** 0 → "0 KB", 812 → "1 KB", 4_404_019 → "4.2 MB", 2_147_483_648 → "2 GB". */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 KB";
  }

  let value = bytes / 1024;
  let unit: (typeof UNITS)[number] = "KB";

  for (const next of UNITS.slice(1)) {
    if (value < 1024) {
      break;
    }

    value /= 1024;
    unit = next;
  }

  if (unit === "KB") {
    return `${Math.max(1, Math.round(value))} KB`;
  }

  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${unit}`;
};
