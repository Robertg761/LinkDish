/**
 * Storage access that never throws.
 *
 * `localStorage`/`sessionStorage` can be present but unusable: Safari Private
 * Browsing, "block all cookies", and Firefox's strict mode all make
 * `setItem` throw (`QuotaExceededError`/`SecurityError`), and merely *reading*
 * the global can throw in sandboxed iframes. A `typeof localStorage ===
 * "undefined"` guard does not protect against any of that, so every call site
 * should go through these helpers instead.
 */

export type WebStorageKind = "local" | "session";

const resolveStorage = (kind: WebStorageKind): Storage | null => {
  try {
    if (typeof globalThis === "undefined") {
      return null;
    }

    const storage = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;

    return storage ?? null;
  } catch {
    return null;
  }
};

/** Reads a key, returning `null` when storage is unavailable or throws. */
export const safeGetItem = (key: string, kind: WebStorageKind = "local"): string | null => {
  try {
    return resolveStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

/** Writes a key. Returns `true` when the value was actually persisted. */
export const safeSetItem = (key: string, value: string, kind: WebStorageKind = "local"): boolean => {
  try {
    const storage = resolveStorage(kind);

    if (!storage) {
      return false;
    }

    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

/** Removes a key. Returns `true` when the removal went through. */
export const safeRemoveItem = (key: string, kind: WebStorageKind = "local"): boolean => {
  try {
    const storage = resolveStorage(kind);

    if (!storage) {
      return false;
    }

    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
};

/** True when the storage area can actually be written to. */
export const isStorageWritable = (kind: WebStorageKind = "local"): boolean => {
  const probeKey = "linkdish:storage-probe";

  try {
    const storage = resolveStorage(kind);

    if (!storage) {
      return false;
    }

    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
};
