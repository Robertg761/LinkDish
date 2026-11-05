import {
  safeGetItem,
  safeKeysWithPrefix,
  safeRemoveItem,
  safeSetItem
} from "../../platform/safe-storage";

/**
 * Check-offs on their way to IndexedDB. A write there takes several round trips, and a reload or
 * closed page in the meantime aborts its transaction, while the screen already showed the item
 * as checked. localStorage writes synchronously, so a tap is noted here before anything else
 * happens and forgotten once the transaction is over. What is still here on the next load never
 * reached IndexedDB, and the list applies it then (see shopping-list-store.ts). Each item has its
 * own key: tabs share localStorage, and rewriting one shared value could drop another tab's tap.
 */

export const SHOPPING_CHECK_JOURNAL_PREFIX = "linkdish:web:shopping-check-journal:v2:";

const keyOf = (id: string): string => `${SHOPPING_CHECK_JOURNAL_PREFIX}${id}`;

/** A check-off, with the account and household it was made for. */
export interface JournaledCheck {
  canSync: boolean;
  checked: boolean;
  householdId?: string | undefined;
  /** The time the write gives the item, which also tells this entry from a later tap. */
  updatedAt: string;
  userId?: string | undefined;
}

type CheckJournal = Record<string, JournaledCheck>;

const isJournaledCheck = (value: unknown): value is JournaledCheck => {
  const check = value as Partial<JournaledCheck> | null;

  return (
    typeof check === "object" &&
    check !== null &&
    typeof check.canSync === "boolean" &&
    typeof check.checked === "boolean" &&
    typeof check.updatedAt === "string" &&
    (check.householdId === undefined || typeof check.householdId === "string") &&
    (check.userId === undefined || typeof check.userId === "string")
  );
};

const readEntry = (key: string): JournaledCheck | null => {
  try {
    const parsed: unknown = JSON.parse(safeGetItem(key) ?? "null");

    return isJournaledCheck(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** The check-offs that haven't reached IndexedDB, by item id. Unreadable entries are left out. */
export const readCheckJournal = (): CheckJournal =>
  Object.fromEntries(
    safeKeysWithPrefix(SHOPPING_CHECK_JOURNAL_PREFIX).flatMap((key) => {
      const check = readEntry(key);

      return check ? [[key.slice(SHOPPING_CHECK_JOURNAL_PREFIX.length), check]] : [];
    })
  );

/** Notes a check-off, replacing an earlier one of the same item. Must run during the tap. */
export const journalCheck = (id: string, check: JournaledCheck): void => {
  safeSetItem(keyOf(id), JSON.stringify(check));
};

/** Forgets a check-off, unless a later tap on the item has replaced it. */
export const forgetJournaledCheck = (id: string, updatedAt: string): void => {
  if (readEntry(keyOf(id))?.updatedAt === updatedAt) {
    safeRemoveItem(keyOf(id));
  }
};
