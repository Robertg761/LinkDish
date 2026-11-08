import { generateKeyPairSync, verify } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

/*
 * deleteAccountAndHouseholdAccess with the outside providers: Clerk (through its admin seam), and
 * Apple and RevenueCat (through fetch, so their real request code runs).
 */

const appleClientId = "com.linkdish.test";
const appleTeamId = "TEAMID1234";
const appleKeyId = "KEYID12345";

const { privateKey: applePrivateKey, publicKey: applePublicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1"
});

const applePrivateKeyPem = applePrivateKey.export({ format: "pem", type: "pkcs8" }).toString();

const importModules = async (env: Record<string, string> = {}) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    APPLE_SIGN_IN_CLIENT_ID: appleClientId,
    APPLE_SIGN_IN_KEY_ID: appleKeyId,
    // Written with \n escapes, as it would be in a one-line environment variable.
    APPLE_SIGN_IN_PRIVATE_KEY: applePrivateKeyPem.replace(/\n/gu, "\\n"),
    APPLE_SIGN_IN_TEAM_ID: appleTeamId,
    AUTH_MODE: "legacy_email_code",
    AUTH_SECRET: "test_auth_secret",
    HOUSEHOLDS_ENABLED: "false",
    NODE_ENV: "test",
    REVENUECAT_SECRET_API_KEY: "test_revenuecat_secret",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "https://upstash.invalid",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  const auth = await import("../auth/auth-service.js");
  const identities = await import("../auth/external-identity-service.js");
  const providers = await import("./account-deletion-providers.js");
  const households = await import("../households/household-service.js");
  const store = await import("../storage/upstash-store.js");

  return { auth, households, identities, providers, store };
};

type Modules = Awaited<ReturnType<typeof importModules>>;

let consoleInfoSpy: MockInstance<typeof console.info>;

const getLastLoginCode = (): string => {
  const message = [...consoleInfoSpy.mock.calls]
    .map(([entry]) => (typeof entry === "string" ? entry : ""))
    .reverse()
    .find((entry) => entry.startsWith("LinkDish login code for "));
  const code = message?.split(": ").at(-1)?.trim();

  if (!code) {
    throw new Error("Login code was not logged.");
  }

  return code;
};

const createUser = async (modules: Modules, email: string): Promise<AccountUser> => {
  await modules.auth.requestLoginCode(email);
  return (await modules.auth.verifyLoginCode(email, getLastLoginCode())).user;
};

/** Links Clerk user `subject` to the account, as a Clerk sign-in does. */
const linkClerkUser = async (modules: Modules, user: AccountUser, subject: string) => {
  await modules.identities.resolveExternalIdentity({
    email: user.email,
    emailVerified: true,
    provider: "clerk",
    subject
  });
};

/** A stand-in for Clerk: subject -> the Apple user IDs linked to that Clerk user. */
const createFakeClerk = (users: Record<string, string[]>) => {
  const deleted = new Set<string>();
  const admin = {
    deleteUser: vi.fn((subject: string) => {
      if (deleted.has(subject) || !(subject in users)) {
        return Promise.resolve("not_found" as const);
      }

      deleted.add(subject);
      return Promise.resolve("deleted" as const);
    }),
    getUser: vi.fn((subject: string) =>
      Promise.resolve(
        deleted.has(subject) || !(subject in users)
          ? null
          : { appleUserIds: users[subject] ?? [], subject }
      )
    )
  };

  return { admin, deleted };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });

const fakeIdToken = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "apple" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature"
  ].join(".");

interface ProviderFetchOptions {
  /** The Apple ID the authorization code turns out to be for. */
  appleUserId?: string;
  appleRevokeStatus?: number;
  appleTokenStatus?: number;
  revenueCatDeleteStatus?: () => number;
}

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const stubProviderFetch = (options: ProviderFetchOptions = {}) => {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);

    if (url === "https://appleid.apple.com/auth/token") {
      return Promise.resolve(
        options.appleTokenStatus && options.appleTokenStatus !== 200
          ? jsonResponse({ error: "invalid_grant" }, options.appleTokenStatus)
          : jsonResponse({
              access_token: "apple-access-token",
              expires_in: 3600,
              id_token: fakeIdToken({
                aud: appleClientId,
                iss: "https://appleid.apple.com",
                sub: options.appleUserId ?? "apple-user-1"
              }),
              refresh_token: "apple-refresh-token",
              token_type: "Bearer"
            })
      );
    }

    if (url === "https://appleid.apple.com/auth/revoke") {
      return Promise.resolve(new Response("", { status: options.appleRevokeStatus ?? 200 }));
    }

    if (url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
      if (init?.method === "DELETE") {
        const status = options.revenueCatDeleteStatus?.() ?? 200;
        return Promise.resolve(
          status === 404
            ? jsonResponse({ code: 7259, message: "Subscriber not found." }, 404)
            : status >= 400
              ? jsonResponse({ message: "RevenueCat is down." }, status)
              : jsonResponse({ app_user_id: "x", deleted: true })
        );
      }

      return Promise.resolve(jsonResponse({ subscriber: { entitlements: {} } }));
    }

    return Promise.reject(new Error(`Unexpected request to ${url}`));
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const requestsTo = (fetchMock: ReturnType<typeof stubProviderFetch>, prefix: string) =>
  fetchMock.mock.calls.filter(([input]) => urlOf(input).startsWith(prefix));

const revenueCatDeletes = (fetchMock: ReturnType<typeof stubProviderFetch>) =>
  requestsTo(fetchMock, "https://api.revenuecat.com/").filter(
    ([, init]) => init?.method === "DELETE"
  );

const formOf = (init: RequestInit | undefined) =>
  Object.fromEntries(new URLSearchParams(init?.body as string));

const expectAccountKept = async (modules: Modules, user: AccountUser, clerkSubject?: string) => {
  await expect(modules.auth.getUserByEmail(user.email)).resolves.not.toBeNull();

  if (clerkSubject) {
    await expect(
      modules.identities.resolveMappedExternalIdentity("clerk", clerkSubject)
    ).resolves.toMatchObject({ id: user.id });
  }
};

const expectAccountDeleted = async (modules: Modules, user: AccountUser, clerkSubject?: string) => {
  await expect(modules.auth.getUserByEmail(user.email)).resolves.toBeNull();

  if (clerkSubject) {
    await expect(
      modules.identities.resolveMappedExternalIdentity("clerk", clerkSubject)
    ).rejects.toMatchObject({ statusCode: 410 });
  }
};

beforeEach(() => {
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("account deletion with outside providers", () => {
  it("deletes a Google-only account's Clerk user and RevenueCat customer, with no Apple step", async () => {
    const fetchMock = stubProviderFetch();
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_google: [] });
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "google@example.com");
    await linkClerkUser(modules, user, "user_clerk_google");

    const providers = await modules.households.deleteAccountAndHouseholdAccess(user, user.email);

    expect(providers).toEqual({ apple: "not_linked", clerk: "deleted", revenueCat: "deleted" });
    expect(clerk.admin.deleteUser).toHaveBeenCalledWith("user_clerk_google");
    expect(requestsTo(fetchMock, "https://appleid.apple.com/")).toEqual([]);

    const [[revenueCatUrl, revenueCatInit]] = revenueCatDeletes(fetchMock) as [
      [string, RequestInit]
    ];
    expect(revenueCatUrl).toBe(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(user.id)}`
    );
    expect(new Headers(revenueCatInit.headers).get("authorization")).toBe(
      "Bearer test_revenuecat_secret"
    );
    await expectAccountDeleted(modules, user, "user_clerk_google");
  });

  it("keeps the stripped record and sign-in tombstone for 90 days, as the privacy policy says", async () => {
    stubProviderFetch();
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_kept: [] });
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "kept@example.com");
    await linkClerkUser(modules, user, "user_clerk_kept");

    await modules.households.deleteAccountAndHouseholdAccess(user, user.email);
    // Clerk's user.deleted webhook for the same user lands after the deletion.
    await modules.identities.tombstoneExternalIdentity("clerk", "user_clerk_kept");

    const ninetyDays = 90 * 86_400;
    expect(modules.auth.deletedAccountRecordTtlSeconds).toBe(ninetyDays);

    for (const key of [
      modules.auth.authKeys.user(user.id),
      modules.identities.externalIdentityKeys.deletedIdentity("clerk", "user_clerk_kept")
    ]) {
      const { result: ttl } = await modules.store.runStoreCommand(["TTL", key]);
      expect(ttl).toBeGreaterThan(ninetyDays - 60);
      expect(ttl).toBeLessThanOrEqual(ninetyDays);
    }

    await expect(
      modules.store.getStoreString(modules.auth.authKeys.user(user.id))
    ).resolves.toContain('"deletedAt"');
  });

  it("finishes the deletion when RevenueCat has no record of the customer", async () => {
    stubProviderFetch({ revenueCatDeleteStatus: () => 404 });
    const modules = await importModules();
    modules.providers.setClerkAccountAdminForTesting(createFakeClerk({}).admin);
    const user = await createUser(modules, "never-paid@example.com");

    const providers = await modules.households.deleteAccountAndHouseholdAccess(user, user.email);

    expect(providers).toEqual({
      apple: "not_linked",
      clerk: "not_linked",
      revenueCat: "no_record"
    });
    await expectAccountDeleted(modules, user);
  });

  it("revokes Sign in with Apple with the code from the app, after checking its Apple ID", async () => {
    const fetchMock = stubProviderFetch({ appleUserId: "apple-user-1" });
    const modules = await importModules();
    modules.providers.setClerkAccountAdminForTesting(
      createFakeClerk({ user_clerk_apple: ["apple-user-1"] }).admin
    );
    const user = await createUser(modules, "apple@example.com");
    await linkClerkUser(modules, user, "user_clerk_apple");

    const providers = await modules.households.deleteAccountAndHouseholdAccess(user, user.email, {
      appleAuthorizationCode: "apple-authorization-code"
    });

    expect(providers).toEqual({ apple: "revoked", clerk: "deleted", revenueCat: "deleted" });

    const [[, tokenInit]] = requestsTo(fetchMock, "https://appleid.apple.com/auth/token") as [
      [string, RequestInit]
    ];
    const tokenForm = formOf(tokenInit);
    expect(tokenForm).toMatchObject({
      client_id: appleClientId,
      code: "apple-authorization-code",
      grant_type: "authorization_code"
    });

    // The client secret is an ES256 JWT signed with the Sign in with Apple key.
    const [header, payload, signature] = String(tokenForm.client_secret).split(".") as [
      string,
      string,
      string
    ];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: appleKeyId
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      aud: "https://appleid.apple.com",
      iss: appleTeamId,
      sub: appleClientId
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { dsaEncoding: "ieee-p1363", key: applePublicKey },
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);

    const [[, revokeInit]] = requestsTo(fetchMock, "https://appleid.apple.com/auth/revoke") as [
      [string, RequestInit]
    ];
    expect(formOf(revokeInit)).toMatchObject({
      client_id: appleClientId,
      token: "apple-refresh-token",
      token_type_hint: "refresh_token"
    });
    await expectAccountDeleted(modules, user, "user_clerk_apple");
  });

  it("stops with nothing deleted when the Apple confirmation is for a different Apple ID", async () => {
    const fetchMock = stubProviderFetch({ appleUserId: "someone-elses-apple-id" });
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_apple: ["apple-user-1"] });
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "apple@example.com");
    await linkClerkUser(modules, user, "user_clerk_apple");

    const failure: unknown = await modules.households
      .deleteAccountAndHouseholdAccess(user, user.email, {
        appleAuthorizationCode: "wrong-apple-id-code"
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(failure).toMatchObject({ statusCode: 409 });
    expect((failure as Error).message).toContain("isn't the one linked to this LinkDish account");

    expect(requestsTo(fetchMock, "https://appleid.apple.com/auth/revoke")).toEqual([]);
    expect(revenueCatDeletes(fetchMock)).toEqual([]);
    expect(clerk.admin.deleteUser).not.toHaveBeenCalled();
    await expectAccountKept(modules, user, "user_clerk_apple");
  });

  it("carries on, reporting Apple as not revoked, when Apple's revocation fails", async () => {
    stubProviderFetch({ appleRevokeStatus: 500 });
    const modules = await importModules();
    modules.providers.setClerkAccountAdminForTesting(
      createFakeClerk({ user_clerk_apple: ["apple-user-1"] }).admin
    );
    const user = await createUser(modules, "apple@example.com");
    await linkClerkUser(modules, user, "user_clerk_apple");

    const providers = await modules.households.deleteAccountAndHouseholdAccess(user, user.email, {
      appleAuthorizationCode: "apple-authorization-code"
    });

    expect(providers).toEqual({ apple: "not_revoked", clerk: "deleted", revenueCat: "deleted" });
    await expectAccountDeleted(modules, user, "user_clerk_apple");
  });

  it("carries on, reporting Apple as not revoked, when Apple won't exchange the code", async () => {
    stubProviderFetch({ appleTokenStatus: 400 });
    const modules = await importModules();
    modules.providers.setClerkAccountAdminForTesting(
      createFakeClerk({ user_clerk_apple: ["apple-user-1"] }).admin
    );
    const user = await createUser(modules, "apple@example.com");
    await linkClerkUser(modules, user, "user_clerk_apple");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email, {
        appleAuthorizationCode: "expired-code"
      })
    ).resolves.toMatchObject({ apple: "not_revoked" });
    await expectAccountDeleted(modules, user, "user_clerk_apple");
  });

  it("reports Apple as not revoked for an Apple-linked account deleted without a code (web, Android)", async () => {
    const fetchMock = stubProviderFetch();
    const modules = await importModules();
    modules.providers.setClerkAccountAdminForTesting(
      createFakeClerk({ user_clerk_apple: ["apple-user-1"] }).admin
    );
    const user = await createUser(modules, "apple@example.com");
    await linkClerkUser(modules, user, "user_clerk_apple");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).resolves.toEqual({ apple: "not_revoked", clerk: "deleted", revenueCat: "deleted" });
    expect(requestsTo(fetchMock, "https://appleid.apple.com/")).toEqual([]);
    await expectAccountDeleted(modules, user, "user_clerk_apple");
  });

  it("reports Apple as not revoked when the server's Apple settings are missing", async () => {
    const fetchMock = stubProviderFetch();
    const modules = await importModules({ APPLE_SIGN_IN_PRIVATE_KEY: "" });
    modules.providers.setClerkAccountAdminForTesting(
      createFakeClerk({ user_clerk_apple: ["apple-user-1"] }).admin
    );
    const user = await createUser(modules, "apple@example.com");
    await linkClerkUser(modules, user, "user_clerk_apple");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email, {
        appleAuthorizationCode: "apple-authorization-code"
      })
    ).resolves.toMatchObject({ apple: "not_revoked" });
    expect(requestsTo(fetchMock, "https://appleid.apple.com/")).toEqual([]);
    await expectAccountDeleted(modules, user);
  });

  it("stops before the account is deleted when RevenueCat fails, and finishes on retry", async () => {
    let revenueCatStatus = 500;
    const fetchMock = stubProviderFetch({ revenueCatDeleteStatus: () => revenueCatStatus });
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_google: [] });
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "billing@example.com");
    await linkClerkUser(modules, user, "user_clerk_google");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(clerk.admin.deleteUser).not.toHaveBeenCalled();
    await expectAccountKept(modules, user, "user_clerk_google");

    revenueCatStatus = 200;
    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).resolves.toEqual({ apple: "not_linked", clerk: "deleted", revenueCat: "deleted" });
    expect(revenueCatDeletes(fetchMock)).toHaveLength(2);
    await expectAccountDeleted(modules, user, "user_clerk_google");
  });

  it("stops before the account is marked deleted when Clerk's delete fails, and finishes on retry", async () => {
    stubProviderFetch();
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_google: [] });
    clerk.admin.deleteUser.mockRejectedValueOnce(new Error("Clerk is down"));
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "clerk@example.com");
    await linkClerkUser(modules, user, "user_clerk_google");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).rejects.toMatchObject({ statusCode: 503 });

    // Still a LinkDish account the person can sign in to and delete again.
    await expectAccountKept(modules, user, "user_clerk_google");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).resolves.toEqual({ apple: "not_linked", clerk: "deleted", revenueCat: "deleted" });
    expect(clerk.deleted.has("user_clerk_google")).toBe(true);
    await expectAccountDeleted(modules, user, "user_clerk_google");
  });

  it("stops with nothing deleted when Clerk can't be reached to look the account up", async () => {
    const fetchMock = stubProviderFetch();
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_google: [] });
    clerk.admin.getUser.mockRejectedValueOnce(new Error("Clerk is down"));
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "clerk-down@example.com");
    await linkClerkUser(modules, user, "user_clerk_google");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clerk.admin.deleteUser).not.toHaveBeenCalled();
    await expectAccountKept(modules, user, "user_clerk_google");
  });

  it("counts a Clerk user that is already gone as deleted", async () => {
    stubProviderFetch();
    const modules = await importModules();
    // Clerk no longer knows the linked user.
    const clerk = createFakeClerk({});
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "gone@example.com");
    await linkClerkUser(modules, user, "user_clerk_gone");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, user.email)
    ).resolves.toEqual({ apple: "not_linked", clerk: "deleted", revenueCat: "deleted" });
    await expectAccountDeleted(modules, user, "user_clerk_gone");
  });

  it("checks the confirmation email before any provider is called", async () => {
    const fetchMock = stubProviderFetch();
    const modules = await importModules();
    const clerk = createFakeClerk({ user_clerk_google: [] });
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);
    const user = await createUser(modules, "confirm@example.com");
    await linkClerkUser(modules, user, "user_clerk_google");

    await expect(
      modules.households.deleteAccountAndHouseholdAccess(user, "other@example.com")
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(clerk.admin.getUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await expectAccountKept(modules, user, "user_clerk_google");
  });

  it("refuses to delete in production without RevenueCat configured, before anything is deleted", async () => {
    const fetchMock = stubProviderFetch();
    const modules = await importModules({
      AUTH_EMAIL_FROM: "LinkDish <login@example.com>",
      NODE_ENV: "production",
      RESEND_API_KEY: "test_resend",
      REVENUECAT_SECRET_API_KEY: ""
    });
    const clerk = createFakeClerk({});
    modules.providers.setClerkAccountAdminForTesting(clerk.admin);

    await expect(
      modules.providers.deleteRevenueCatCustomerForAccount("user_1")
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
