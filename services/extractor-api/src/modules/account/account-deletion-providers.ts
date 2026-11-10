import { sign } from "node:crypto";

import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";

import { extractorApiEnv } from "../../config/env.js";
import { listExternalIdentitiesForUser } from "../auth/external-identity-service.js";
import { invalidateRevenueCatEntitlementCache } from "../billing/revenuecat-entitlements.js";

import type { AccountDeletionProviders } from "../../../../../packages/api-contracts/src/index.js";

/*
 * The outside providers an account deletion has to clean up (Clerk, Sign in with Apple and
 * RevenueCat). deleteAccountAndHouseholdAccess (households/household-service.ts) decides the order;
 * every call here is safe to repeat, so a deletion that stopped part-way can simply be retried.
 */

/** A deletion step that stops the deletion. statusCode is what the person's request answers. */
export class AccountDeletionError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "AccountDeletionError";
  }
}

const providerTimeoutMs = 5_000;
const retryMessage = "Your account has not been deleted. Please try again in a moment.";

/* ------------------------------------------------------------------------------------------------
 * Clerk
 * --------------------------------------------------------------------------------------------- */

export interface ClerkDeletionUser {
  /** Apple's user IDs ("sub") of the Apple IDs linked to this Clerk user through Sign in with Apple. */
  appleUserIds: string[];
  subject: string;
}

/** A Clerk user linked to the account; `exists` is false when Clerk has already deleted it. */
export interface AccountClerkUser extends ClerkDeletionUser {
  exists: boolean;
}

export interface ClerkAccountAdmin {
  /** The Clerk user, or null when Clerk has no such user (already deleted). */
  getUser(subject: string): Promise<ClerkDeletionUser | null>;
  /** "not_found" when Clerk has no such user (already deleted). */
  deleteUser(subject: string): Promise<"deleted" | "not_found">;
}

const isAppleProvider = (provider: string): boolean =>
  provider === "oauth_apple" || provider === "apple";

const isClerkNotFound = (error: unknown): boolean =>
  isClerkAPIResponseError(error) && error.status === 404;

const createDefaultClerkAccountAdmin = (): ClerkAccountAdmin => {
  const getClient = () => {
    if (!extractorApiEnv.CLERK_SECRET_KEY) {
      throw new Error("CLERK_SECRET_KEY is required to delete Clerk users.");
    }

    return createClerkClient({ secretKey: extractorApiEnv.CLERK_SECRET_KEY });
  };

  return {
    async deleteUser(subject) {
      try {
        await getClient().users.deleteUser(subject);
        return "deleted";
      } catch (error) {
        if (isClerkNotFound(error)) {
          return "not_found";
        }

        throw error;
      }
    },
    async getUser(subject) {
      try {
        const user = await getClient().users.getUser(subject);

        return {
          appleUserIds: user.externalAccounts
            .filter((account) => isAppleProvider(account.provider) && account.providerUserId)
            .map((account) => account.providerUserId),
          subject
        };
      } catch (error) {
        if (isClerkNotFound(error)) {
          return null;
        }

        throw error;
      }
    }
  };
};

let clerkAccountAdmin: ClerkAccountAdmin = createDefaultClerkAccountAdmin();

export const setClerkAccountAdminForTesting = (admin: ClerkAccountAdmin): void => {
  clerkAccountAdmin = admin;
};

export const resetClerkAccountAdminForTesting = (): void => {
  clerkAccountAdmin = createDefaultClerkAccountAdmin();
};

/**
 * The Clerk users linked to the account, with the Apple IDs linked to them. Throws (with nothing
 * changed) when Clerk can't be reached.
 */
export const lookUpClerkUsersForAccount = async (userId: string): Promise<AccountClerkUser[]> => {
  const subjects = (await listExternalIdentitiesForUser(userId))
    .filter((identity) => identity.provider === "clerk")
    .map((identity) => identity.subject);
  const users: AccountClerkUser[] = [];

  for (const subject of subjects) {
    try {
      const user = await clerkAccountAdmin.getUser(subject);

      users.push(user ? { ...user, exists: true } : { appleUserIds: [], exists: false, subject });
    } catch (error) {
      console.error("Account deletion could not look up the Clerk user.", error);
      throw new AccountDeletionError(`We couldn't reach our sign-in service. ${retryMessage}`, 503);
    }
  }

  return users;
};

/**
 * Deletes the account's Clerk users. One already gone counts as deleted. Any other failure throws,
 * so the deletion stops while the person can still sign in and try again.
 */
export const deleteClerkUsersForAccount = async (
  users: AccountClerkUser[]
): Promise<AccountDeletionProviders["clerk"]> => {
  for (const user of users.filter((clerkUser) => clerkUser.exists)) {
    try {
      await clerkAccountAdmin.deleteUser(user.subject);
    } catch (error) {
      console.error("Account deletion could not delete the Clerk user.", error);
      throw new AccountDeletionError(`We couldn't remove your sign-in. ${retryMessage}`, 503);
    }
  }

  return users.length > 0 ? "deleted" : "not_linked";
};

/* ------------------------------------------------------------------------------------------------
 * Sign in with Apple
 * --------------------------------------------------------------------------------------------- */

const appleIssuer = "https://appleid.apple.com";
const appleTokenUrl = "https://appleid.apple.com/auth/token";
const appleRevokeUrl = "https://appleid.apple.com/auth/revoke";

export interface AppleSignInConfig {
  /** The iOS app's bundle ID: the client the authorization code was issued to. */
  clientId: string;
  keyId: string;
  /** The Sign in with Apple .p8 key (PKCS#8 PEM). */
  privateKey: string;
  teamId: string;
}

/** null until all four APPLE_SIGN_IN_* values are set on the server. */
export const getAppleSignInConfig = (): AppleSignInConfig | null => {
  const {
    APPLE_SIGN_IN_CLIENT_ID: clientId,
    APPLE_SIGN_IN_KEY_ID: keyId,
    APPLE_SIGN_IN_PRIVATE_KEY: privateKey,
    APPLE_SIGN_IN_TEAM_ID: teamId
  } = extractorApiEnv;

  if (!clientId || !keyId || !privateKey || !teamId) {
    return null;
  }

  return { clientId, keyId, privateKey: privateKey.replace(/\\n/gu, "\n"), teamId };
};

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** The ES256-signed client secret Apple's token and revoke endpoints ask for. */
export const createAppleClientSecret = (
  config: AppleSignInConfig,
  nowSeconds = Math.floor(Date.now() / 1000)
): string => {
  const signingInput = `${base64UrlJson({ alg: "ES256", kid: config.keyId })}.${base64UrlJson({
    aud: appleIssuer,
    exp: nowSeconds + 300,
    iat: nowSeconds,
    iss: config.teamId,
    sub: config.clientId
  })}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    dsaEncoding: "ieee-p1363",
    key: config.privateKey
  });

  return `${signingInput}.${signature.toString("base64url")}`;
};

const postAppleForm = (url: string, form: Record<string, string>): Promise<Response> =>
  fetch(url, {
    body: new URLSearchParams(form).toString(),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    method: "POST",
    signal: AbortSignal.timeout(providerTimeoutMs)
  });

interface AppleTokenGrant {
  appleUserId: string;
  token: string;
  tokenTypeHint: "access_token" | "refresh_token";
}

/*
 * The ID token comes straight from Apple's token endpoint over TLS in answer to our own signed
 * request, so its claims are read without checking its signature (OpenID Connect Core 3.1.3.7).
 */
const readIdTokenClaims = (idToken: string): { aud?: unknown; iss?: unknown; sub?: unknown } => {
  const payload = idToken.split(".")[1];

  if (!payload) {
    throw new Error("Apple returned an ID token without claims.");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    aud?: unknown;
    iss?: unknown;
    sub?: unknown;
  };
};

const exchangeAppleAuthorizationCode = async (
  code: string,
  config: AppleSignInConfig
): Promise<AppleTokenGrant> => {
  const response = await postAppleForm(appleTokenUrl, {
    client_id: config.clientId,
    client_secret: createAppleClientSecret(config),
    code,
    grant_type: "authorization_code"
  });

  if (!response.ok) {
    throw new Error(`Apple token exchange failed with ${response.status}.`);
  }

  const body = (await response.json()) as {
    access_token?: unknown;
    id_token?: unknown;
    refresh_token?: unknown;
  };
  const claims = typeof body.id_token === "string" ? readIdTokenClaims(body.id_token) : {};
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.iss !== appleIssuer ||
    !audiences.includes(config.clientId)
  ) {
    throw new Error("Apple's token answer did not identify an Apple ID for this app.");
  }

  if (typeof body.refresh_token === "string" && body.refresh_token) {
    return { appleUserId: claims.sub, token: body.refresh_token, tokenTypeHint: "refresh_token" };
  }

  if (typeof body.access_token === "string" && body.access_token) {
    return { appleUserId: claims.sub, token: body.access_token, tokenTypeHint: "access_token" };
  }

  throw new Error("Apple's token answer held no token to revoke.");
};

const revokeAppleToken = async (grant: AppleTokenGrant, config: AppleSignInConfig) => {
  const response = await postAppleForm(appleRevokeUrl, {
    client_id: config.clientId,
    client_secret: createAppleClientSecret(config),
    token: grant.token,
    token_type_hint: grant.tokenTypeHint
  });

  if (!response.ok) {
    throw new Error(`Apple token revocation failed with ${response.status}.`);
  }
};

/**
 * Revokes LinkDish's Sign in with Apple access for the account's Apple ID, using an authorization
 * code the iOS app just got from Apple.
 *
 * Throws (stopping the deletion before anything is deleted) only when the code belongs to an Apple
 * ID other than the one linked to the account. Anything else that keeps the revocation from
 * happening (no code, the server's Apple settings missing, Apple failing) answers "not_revoked":
 * the deletion carries on and the person is told to turn it off in their Apple Account settings.
 */
export const revokeAppleSignInForAccount = async (
  linkedAppleUserIds: string[],
  authorizationCode: string | undefined
): Promise<AccountDeletionProviders["apple"]> => {
  if (linkedAppleUserIds.length === 0) {
    return "not_linked";
  }

  if (!authorizationCode) {
    return "not_revoked";
  }

  const config = getAppleSignInConfig();

  if (!config) {
    console.error(
      "Account deletion could not revoke Sign in with Apple: the APPLE_SIGN_IN_* settings are missing."
    );
    return "not_revoked";
  }

  let grant: AppleTokenGrant;

  try {
    grant = await exchangeAppleAuthorizationCode(authorizationCode, config);
  } catch (error) {
    console.error("Account deletion could not exchange the Apple authorization code.", error);
    return "not_revoked";
  }

  if (!linkedAppleUserIds.includes(grant.appleUserId)) {
    throw new AccountDeletionError(
      "That Apple ID isn't the one linked to this LinkDish account. Your account has not been deleted. Try again and confirm with the Apple ID you use to sign in to LinkDish.",
      409
    );
  }

  try {
    await revokeAppleToken(grant, config);
    return "revoked";
  } catch (error) {
    console.error("Account deletion could not revoke the Apple token.", error);
    return "not_revoked";
  }
};

/* ------------------------------------------------------------------------------------------------
 * RevenueCat
 * --------------------------------------------------------------------------------------------- */

/**
 * Deletes the RevenueCat customer (the LinkDish user ID is the RevenueCat app user ID on every
 * platform). RevenueCat answering "not found" means there was no record, which is fine. Any other
 * failure throws, so the deletion stops and a retry can finish it. Deleting the customer does not
 * cancel a store subscription.
 */
export const deleteRevenueCatCustomerForAccount = async (
  userId: string
): Promise<AccountDeletionProviders["revenueCat"]> => {
  const secretApiKey = extractorApiEnv.REVENUECAT_SECRET_API_KEY;

  if (!secretApiKey) {
    if (extractorApiEnv.NODE_ENV === "production") {
      console.error("Account deletion needs REVENUECAT_SECRET_API_KEY in production.");
      throw new AccountDeletionError(`We couldn't reach our billing service. ${retryMessage}`, 503);
    }

    return "not_configured";
  }

  let response: Response;

  try {
    response = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${secretApiKey}`
        },
        method: "DELETE",
        signal: AbortSignal.timeout(providerTimeoutMs)
      }
    );
  } catch (error) {
    console.error("Account deletion could not reach RevenueCat.", error);
    throw new AccountDeletionError(`We couldn't reach our billing service. ${retryMessage}`, 503);
  }

  if (response.status === 404) {
    return "no_record";
  }

  if (!response.ok) {
    console.error(
      "Account deletion could not delete the RevenueCat customer.",
      response.status,
      await response.text().catch(() => "")
    );
    throw new AccountDeletionError(`We couldn't reach our billing service. ${retryMessage}`, 503);
  }

  // A cached paid plan for the deleted customer must not outlive it.
  await Promise.resolve()
    .then(() => invalidateRevenueCatEntitlementCache(userId))
    .catch(() => undefined);

  return "deleted";
};
