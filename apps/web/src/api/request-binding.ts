/**
 * Ties an API request to the account that makes it. A request's credentials are read only when it
 * goes out (after the API client loads and a token is fetched), so a request made for one account
 * could otherwise be sent with the next account's token if Clerk switched sessions in between,
 * and change that account's household, profile or billing. A bound request checks again once its
 * credentials are in hand and, if another account (or Clerk session) is signed in by then, sends
 * nothing and rejects with {@link AccountChangedError}.
 */
import { getCurrentAccount } from "../auth/account-scope";
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
 * Clerk hasn't switched away from the session it was made under. A request made while Clerk was
 * still loading (no session yet) may go out under the session Clerk then settles on.
 */
export const isBindingCurrent = (bound: RequestBinding): boolean =>
  getCurrentAccount() === bound.account &&
  (bound.clerkSessionId === null || signedInClerkSession() === bound.clerkSessionId);
