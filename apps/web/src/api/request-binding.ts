/**
 * Ties an API request to the account that makes it. A request's credentials are read only when it
 * goes out (after the API client loads and a token is fetched), so a request made for one account
 * could otherwise be sent with the next account's token if Clerk switched sessions in between,
 * and change that account's household, profile or billing. A bound request checks again once its
 * credentials are in hand and, if another account (or Clerk session) is signed in by then, sends
 * nothing and rejects with {@link AccountChangedError}.
 */
import { getTokenSessionId } from "@linkdish/utils/src/token-session";

import { getCurrentAccount, whenAccountConfirmed } from "../auth/account-scope";
import { getClerkBridgeSnapshot } from "../auth/clerk-bridge";

export interface RequestBinding {
  /** The account the request is for (see `getAccountScope`). */
  account: string | null;
  /** The Clerk session signed in when the request was made (null: none yet, or not Clerk). */
  clerkSessionId: string | null;
}

/** A bound request was not sent: another account signed in (or out) before it went out. */
export class AccountChangedError extends Error {
  public constructor() {
    super("Another account signed in before this request was sent.");
    this.name = "AccountChangedError";
  }
}

export const isAccountChangedError = (error: unknown): error is AccountChangedError =>
  error instanceof Error && error.name === "AccountChangedError";

const signedInClerkSession = (): string | null => {
  const clerk = getClerkBridgeSnapshot();
  return clerk.isSignedIn ? clerk.sessionId : null;
};

let binding: RequestBinding | null = null;

/**
 * Makes the API requests `request` starts synchronously (call the `apiClient` method first thing,
 * before any await) for `account` only: each is sent only while that account is still the one
 * signed in, under the Clerk session it had when the request was made.
 */
export function asAccount<Result>(
  account: string | null,
  request: () => Promise<Result>
): Promise<Result> {
  const previous = binding;
  binding = { account, clerkSessionId: signedInClerkSession() };

  try {
    return request();
  } finally {
    binding = previous;
  }
}

/** The binding of the request being made right now; read synchronously by the API client. */
export const getRequestBinding = (): RequestBinding | null => binding;

/**
 * Whether a request bound to `bound` may still go out: its account is the one signed in, and
 * Clerk hasn't switched away from the session it was made under.
 */
export const isBindingCurrent = (bound: RequestBinding): boolean =>
  getCurrentAccount() === bound.account &&
  (bound.clerkSessionId === null || signedInClerkSession() === bound.clerkSessionId);

/** How long a bound request waits for its account to be confirmed under the session it carries. */
export const ACCOUNT_CONFIRMATION_WAIT_MS = 10_000;

/**
 * Checks the credentials a bound request is about to carry (its headers, token in hand) and
 * rejects with {@link AccountChangedError} unless they are its account's. A request made signed
 * out carries none: credentials then are an account that signed in since (and may still be being
 * looked up), which it must not act for or be charged to. A Clerk token must be for the session
 * the request's account was confirmed under. A request made while a cached account was shown and
 * Clerk still loading waits (briefly) for that check, so it never goes out with the token of
 * another account Clerk settled on.
 */
export async function assertBoundCredentials(
  bound: RequestBinding,
  headers: Record<string, string>
): Promise<void> {
  if (!isBindingCurrent(bound)) {
    throw new AccountChangedError();
  }

  if (bound.account === null) {
    if (headers.authorization) {
      throw new AccountChangedError();
    }

    return;
  }

  const tokenSession = getTokenSessionId(/^Bearer (.+)$/u.exec(headers.authorization ?? "")?.[1]);

  // No Clerk token (a legacy session): the account check above is all there is.
  if (tokenSession === null) {
    return;
  }

  if (
    (bound.clerkSessionId !== null && tokenSession !== bound.clerkSessionId) ||
    !(await whenAccountConfirmed(bound.account, tokenSession, ACCOUNT_CONFIRMATION_WAIT_MS)) ||
    !isBindingCurrent(bound)
  ) {
    throw new AccountChangedError();
  }
}
