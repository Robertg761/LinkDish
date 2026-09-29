/** A request made for one account was not sent: another signed in (or out) before it went out. */
export class AccountChangedError extends Error {
  public constructor() {
    super("Another account signed in before this request was sent.");
    this.name = "AccountChangedError";
  }
}

export const isAccountChangedError = (error: unknown): error is AccountChangedError =>
  error instanceof Error && error.name === "AccountChangedError";
