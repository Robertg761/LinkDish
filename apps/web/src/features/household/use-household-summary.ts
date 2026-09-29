import { useEffect, useState } from "react";

import { apiClient } from "../../api/client";
import { asAccount, isAccountChangedError } from "../../api/request-binding";

import type { HouseholdDetails, HouseholdMember } from "@linkdish/api-contracts";

export type HouseholdSummaryStatus = "idle" | "loading" | "ready" | "error";

export interface HouseholdSummary {
  status: HouseholdSummaryStatus;
  household: HouseholdDetails | null;
}

const IDLE: HouseholdSummary = { household: null, status: "idle" };
const LOADING: HouseholdSummary = { household: null, status: "loading" };

/**
 * The signed-in person's household, read once per account. Used by money screens to tell whose
 * subscription a Family plan comes from. `idle` when signed out; `error` when it couldn't be read.
 * It waits while the request would not carry the account yet (`credentialsKey` is null) and asks
 * again when the credentials change. Its answer is kept with the account it was asked for, so
 * another account (signing straight in, or out) never sees it, not even for a render.
 */
export function useHouseholdSummary(
  enabled: boolean,
  userId: string | undefined,
  /** `useAuth().credentialsKey`. */
  credentialsKey: string | null
): HouseholdSummary {
  const account = enabled ? (userId ?? "") : null;
  const [loaded, setLoaded] = useState<{ account: string | null; summary: HouseholdSummary }>(
    () => ({ account, summary: account === null ? IDLE : LOADING })
  );

  useEffect(() => {
    if (account === null) {
      setLoaded((current) =>
        current.account === null ? current : { account: null, summary: IDLE }
      );
      return;
    }

    // The same account asking again (new credentials) keeps its answer until the next arrives.
    setLoaded((current) => (current.account === account ? current : { account, summary: LOADING }));

    if (credentialsKey === null) {
      return;
    }

    let cancelled = false;

    asAccount(account, () => apiClient.getHousehold()).then(
      (response) => {
        if (!cancelled) {
          setLoaded({ account, summary: { household: response.household, status: "ready" } });
        }
      },
      (error: unknown) => {
        // Not sent: another account signed in first, and asks for its own.
        if (!cancelled && !isAccountChangedError(error)) {
          setLoaded({ account, summary: { household: null, status: "error" } });
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [account, credentialsKey]);

  if (loaded.account !== account) {
    return account === null ? IDLE : LOADING;
  }

  return loaded.summary;
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
