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

let currentAccount: string | null = null;

/**
 * The account signed in now (see {@link getAccountScope}), as the auth provider last rendered it:
 * for work that outlives the component that started it, such as a toast's action, which
 * {@link useIsCurrentAccount} can't follow once that component is gone.
 */
export const getCurrentAccount = (): string | null => currentAccount;

/** Called by the auth provider whenever the signed-in account changes. */
export const publishCurrentAccount = (account: string | null): void => {
  currentAccount = account;
};

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
