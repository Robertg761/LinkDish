import { useCallback, useRef } from "react";

import type { AccountUser } from "@linkdish/api-contracts";

/**
 * The account that account-scoped state belongs to: the signed-in user's id, or null when signed
 * out. What one account loaded, typed or opened is tagged with (or keyed by) it, so it is never
 * shown to, or acted on for, the next account when one replaces another directly (a cached user
 * swapped once Clerk answers, or a sign-out while a request is out).
 */
export const getAccountScope = (
  isAuthenticated: boolean,
  user: Pick<AccountUser, "id"> | null | undefined
): string | null => (isAuthenticated ? (user?.id ?? "") : null);

/**
 * A stable check for async work that must land only on the account it started for: pass the
 * account captured when the work started, and it answers whether that account is still the one
 * signed in. Call the hook where it keeps rendering across account changes (not inside a subtree
 * keyed by the account, which unmounts on a change and would stop seeing new accounts).
 */
export function useIsCurrentAccount(
  account: string | null
): (startedFor: string | null) => boolean {
  const accountRef = useRef(account);
  accountRef.current = account;

  return useCallback((startedFor: string | null) => accountRef.current === startedFor, []);
}
