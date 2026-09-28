/**
 * One counting model for the free cookbook, shared by every screen that shows it (Cookbook header
 * and meter, Account, the upgrade sheet, Settings):
 *
 * - "saved" recipes are the cook's own and count toward the free limit;
 * - starter recipes (LinkDish's samples) never count, and every quota message says so;
 * - counts are never clamped: 17 saved on a 15-recipe plan reads "17 of 15 saved", because
 *   pretending it is 15 made the numbers disagree from screen to screen.
 */

const pluralize = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

/** From this many saved recipes the meter turns into a friendly upgrade prompt. */
export const QUOTA_NEARLY_FULL_AT = 12;

export type FreeQuotaState = "roomy" | "nearly_full" | "full" | "over";

export interface CookbookCounts {
  /** The cook's own recipes (they count toward the free limit). */
  saved: number;
  /** LinkDish's starter recipes (they never count). */
  starters: number;
}

export interface FreeQuotaSummary extends CookbookCounts {
  limit: number;
  state: FreeQuotaState;
  /** Saves left before the limit (0 when full or over). */
  remaining: number;
  /** Recipes past the limit (a cookbook that shrank from Plus, or saved before the limit). */
  over: number;
  /** "13 of 15 saved" — the true count, never clamped to the limit. */
  valueText: string;
  /** One short line for the state: "2 left", "Plus makes it unlimited", "2 over the free limit". */
  statusText: string;
  /** "3 starter recipes don't count." when there are starters, else null. */
  starterNote: string | null;
  /** Progress bar colour by urgency. */
  tone: "primary" | "butter" | "tomato";
}

export const getFreeQuotaState = (saved: number, limit: number): FreeQuotaState =>
  saved > limit
    ? "over"
    : saved >= limit
      ? "full"
      : saved >= Math.min(QUOTA_NEARLY_FULL_AT, limit - 1)
        ? "nearly_full"
        : "roomy";

export const formatStarterNote = (starters: number): string | null =>
  starters > 0
    ? `${starters === 1 ? "The starter recipe doesn't" : `${starters} starter recipes don't`} count.`
    : null;

export const describeFreeQuota = (
  { saved, starters }: CookbookCounts,
  limit: number
): FreeQuotaSummary => {
  const state = getFreeQuotaState(saved, limit);
  const remaining = Math.max(0, limit - saved);
  const over = Math.max(0, saved - limit);

  return {
    limit,
    over,
    remaining,
    saved,
    starterNote: formatStarterNote(starters),
    starters,
    state,
    statusText:
      state === "over"
        ? `${over} over the free limit`
        : state === "full"
          ? "Plus makes it unlimited"
          : `${remaining} left`,
    tone: state === "roomy" ? "primary" : state === "nearly_full" ? "butter" : "tomato",
    valueText: `${saved} of ${limit} saved`
  };
};

/**
 * The Cookbook's own count: "17 recipes + 3 starters", "3 starter recipes", "No recipes yet".
 * Starters are named separately so the header always adds up with the free-cookbook meter.
 */
export const formatCookbookCount = ({ saved, starters }: CookbookCounts): string => {
  if (saved === 0) {
    return starters > 0 ? pluralize(starters, "starter recipe") : "No recipes yet";
  }

  return starters > 0
    ? `${pluralize(saved, "recipe")} + ${pluralize(starters, "starter")}`
    : pluralize(saved, "recipe");
};
