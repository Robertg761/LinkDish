/**
 * Keeping object identity across re-reads. IndexedDB hands back structured clones, so a record
 * read again is always a new object even when nothing in it changed. Reusing the previous object
 * for equal data lets memoized cards, per-recipe caches (WeakMaps) and search indexes survive
 * a same-tab write echo or another tab's change.
 */

/** Structural equality for JSON-like data (plain objects, arrays, primitives). */
export const isDeepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }

  if (Array.isArray(left)) {
    const rightArray = right as unknown[];
    return (
      left.length === rightArray.length &&
      left.every((value, index) => isDeepEqual(value, rightArray[index]))
    );
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => isDeepEqual(leftRecord[key], rightRecord[key]))
  );
};

/**
 * `next`, but reusing records from `previous` (matched by id) that are unchanged — and returning
 * `previous` itself when the whole list is unchanged. `reconcileRecord` may return a merged
 * record that keeps unchanged parts of the previous one.
 */
export function reconcileById<T>(
  previous: readonly T[],
  next: readonly T[],
  getId: (record: T) => string,
  reconcileRecord: (previousRecord: T, nextRecord: T) => T = (previousRecord, nextRecord) =>
    isDeepEqual(previousRecord, nextRecord) ? previousRecord : nextRecord
): T[] {
  const previousById = new Map(previous.map((record) => [getId(record), record]));
  let unchanged = previous.length === next.length;

  const reconciled = next.map((record, index) => {
    const before = previousById.get(getId(record));
    const kept = before ? reconcileRecord(before, record) : record;

    if (kept !== previous[index]) {
      unchanged = false;
    }

    return kept;
  });

  return unchanged ? (previous as T[]) : reconciled;
}
