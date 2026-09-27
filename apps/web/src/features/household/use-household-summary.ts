import { useEffect, useState } from "react";

import { apiClient } from "../../api/client";

import type { HouseholdDetails, HouseholdMember } from "@linkdish/api-contracts";

export type HouseholdSummaryStatus = "idle" | "loading" | "ready" | "error";

export interface HouseholdSummary {
  status: HouseholdSummaryStatus;
  household: HouseholdDetails | null;
}

/**
 * The signed-in person's household, read once per account. Used by money screens to tell whose
 * subscription a Family plan comes from. `idle` when signed out; `error` when it couldn't be read.
 */
export function useHouseholdSummary(
  enabled: boolean,
  userId: string | undefined
): HouseholdSummary {
  const [summary, setSummary] = useState<HouseholdSummary>({
    household: null,
    status: enabled ? "loading" : "idle"
  });

  useEffect(() => {
    if (!enabled) {
      setSummary({ household: null, status: "idle" });
      return;
    }

    let cancelled = false;
    setSummary({ household: null, status: "loading" });

    apiClient.getHousehold().then(
      (response) => {
        if (!cancelled) {
          setSummary({ household: response.household, status: "ready" });
        }
      },
      () => {
        if (!cancelled) {
          setSummary({ household: null, status: "error" });
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [enabled, userId]);

  return summary;
}

export const getHouseholdOwner = (household: HouseholdDetails | null): HouseholdMember | null =>
  household?.members.find((member) => member.userId === household.ownerUserId) ??
  household?.members.find((member) => member.role === "owner") ??
  null;

export const getMemberDisplayName = (member: Pick<HouseholdMember, "displayName" | "email">) =>
  member.displayName?.trim() || member.email.split("@")[0] || member.email;

/** "Sam Rivera" → "SR", "cook@example.com" → "CO". */
export const getInitials = (name: string): string => {
  const words = name
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  // Array.from walks code points, so a name that starts with an emoji or accent isn't split.
  const first = Array.from(words[0] ?? "");
  const second = Array.from(words[1] ?? "");
  const initials =
    second.length > 0 ? `${first[0] ?? ""}${second[0] ?? ""}` : first.slice(0, 2).join("");

  return (initials || "?").toUpperCase();
};
