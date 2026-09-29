import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCookSession } from "../../data/cook-session-store";
import { queueCookSessionUpdate } from "../cook-mode/cook-session-writer";

import type { Recipe } from "@linkdish/recipe-domain";

/**
 * Ticked-off ingredients, kept in the recipe's cook session (IndexedDB) so the ticks made on the
 * recipe page carry into cook mode and survive a reload. Without a session key (nothing to
 * persist against) the ticks live in memory only.
 */

/** Stable per-line key: the index keeps repeated lines apart, the text drops ticks after edits. */
export const getIngredientKey = (index: number, text: string): string => `${index}:${text}`;

export interface IngredientEntry {
  index: number;
  key: string;
  text: string;
}

export interface IngredientGroup {
  key: string;
  section: string | null;
  items: IngredientEntry[];
}

/** Consecutive ingredients that share a section heading. */
export const groupRecipeIngredients = (ingredients: Recipe["ingredients"]): IngredientGroup[] => {
  const groups: IngredientGroup[] = [];

  ingredients.forEach((ingredient, index) => {
    const section = ingredient.section?.trim() || null;
    const current = groups[groups.length - 1];

    if (!current || current.section !== section) {
      groups.push({ items: [], key: `group-${index}`, section });
    }

    groups[groups.length - 1]?.items.push({
      index,
      key: getIngredientKey(index, ingredient.text),
      text: ingredient.text
    });
  });

  return groups;
};

export interface IngredientChecks {
  checked: ReadonlySet<string>;
  toggle: (key: string) => void;
  setChecked: (keys: Iterable<string>) => void;
  clear: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useIngredientChecks = (sessionKey: string | null | undefined): IngredientChecks => {
  const { session } = useCookSession(sessionKey ?? undefined);
  const stored = session?.checkedIngredients;
  const storedSet = useMemo<ReadonlySet<string>>(
    () => (stored ? new Set(stored) : EMPTY),
    [stored]
  );
  // Ticks shown before the write lands (and the only copy when there is no session key).
  const [local, setLocal] = useState<{ key: string | null; set: ReadonlySet<string> } | null>(null);
  const pendingWritesRef = useRef(0);
  const localForKey = local && local.key === (sessionKey ?? null) ? local.set : null;
  const checked = localForKey ?? storedSet;
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  useEffect(() => {
    if (sessionKey && pendingWritesRef.current === 0) {
      setLocal(null);
    }
  }, [sessionKey, storedSet]);

  /**
   * Shows `next` and saves it; with `change`, saves `change` applied to the ticks as stored when
   * the write happens instead, so a line another tab ticked meanwhile stays ticked.
   */
  const commit = useCallback(
    (next: ReadonlySet<string>, change?: (stored: readonly string[]) => string[]) => {
      setLocal({ key: sessionKey ?? null, set: next });

      if (!sessionKey) {
        return;
      }

      pendingWritesRef.current += 1;
      void queueCookSessionUpdate(
        sessionKey,
        change
          ? (session) => ({ checkedIngredients: change(session.checkedIngredients) })
          : { checkedIngredients: Array.from(next) }
      )
        .catch((error: unknown) => {
          console.warn("Could not save ticked ingredients.", error);
        })
        .finally(() => {
          pendingWritesRef.current -= 1;
        });
    },
    [sessionKey]
  );

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(checkedRef.current);
      const tick = !next.has(key);

      if (tick) {
        next.add(key);
      } else {
        next.delete(key);
      }

      commit(next, (stored) =>
        tick
          ? Array.from(new Set([...stored, key]))
          : stored.filter((storedKey) => storedKey !== key)
      );
    },
    [commit]
  );

  const setChecked = useCallback((keys: Iterable<string>) => commit(new Set(keys)), [commit]);
  const clear = useCallback(() => commit(new Set()), [commit]);

  return { checked, clear, setChecked, toggle };
};
