/**
 * Whether a stored value that should hold a JSON list is there but can't be read as one (a
 * truncated write, say). Such a value is copied aside before anything is written over it.
 */
export const isUnreadableStoredList = (serialized: string | null | undefined): boolean => {
  if (!serialized) {
    return false;
  }

  try {
    return !Array.isArray(JSON.parse(serialized));
  } catch {
    return true;
  }
};
