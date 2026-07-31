import { afterEach, describe, expect, it, vi } from "vitest";

const importServices = async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_MODE", "clerk_beta");
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "7776000");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

  const auth = await import("./auth-service.js");
  const clerk = await import("./clerk-auth-service.js");

  return {
    auth,
    clerk
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("clerk-auth-service", () => {
  it("resolves a Clerk token to the existing AccountUser shape", async () => {
    const { auth, clerk } = await importServices();

    clerk.setClerkAuthVerifierForTesting({
      getExternalIdentity(subject) {
        return Promise.resolve({
          email: "clerk@example.com",
          emailVerified: true,
          subject
        });
      },
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_user_1"
        });
      }
    });

    await expect(
      auth.getAuthenticatedUser({
        authorization: "Bearer header.payload.signature"
      })
    ).resolves.toMatchObject({
      expiresAt: "2026-06-01T00:00:00.000Z",
      sessionTokenHash: "clerk:clerk_user_1",
      user: {
        email: "clerk@example.com"
      }
    });
  });

  it("does not fetch Clerk user details when the identity is already mapped", async () => {
    const { auth, clerk } = await importServices();
    const { tombstoneExternalIdentitiesForUser } = await import("./external-identity-service.js");
    const getExternalIdentity = vi.fn().mockResolvedValue({
      email: "should-not-fetch@example.com",
      emailVerified: true,
      subject: "clerk_mapped"
    });

    clerk.setClerkAuthVerifierForTesting({
      getExternalIdentity,
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_mapped"
        });
      }
    });

    const firstSession = await auth.getAuthenticatedUser({
      authorization: "Bearer header.payload.signature"
    });
    expect(firstSession?.user.email).toBe("should-not-fetch@example.com");
    expect(getExternalIdentity).toHaveBeenCalledTimes(1);

    getExternalIdentity.mockClear();
    const secondSession = await auth.getAuthenticatedUser({
      authorization: "Bearer header.payload.signature"
    });

    expect(secondSession?.user).toEqual(firstSession?.user);
    expect(getExternalIdentity).not.toHaveBeenCalled();

    await tombstoneExternalIdentitiesForUser(firstSession!.user.id);
    await expect(
      auth.getAuthenticatedUser({
        authorization: "Bearer header.payload.signature"
      })
    ).rejects.toMatchObject({
      message: "This LinkDish account has been deleted. Contact support to recover it.",
      statusCode: 410
    });
  });

  it("keeps Clerk tokens disabled in legacy_email_code mode", async () => {
    vi.resetModules();
    vi.stubEnv("AUTH_MODE", "legacy_email_code");
    vi.stubEnv("AUTH_SECRET", "test_auth_secret");
    vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "7776000");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.invalid");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const auth = await import("./auth-service.js");

    await expect(
      auth.getAuthenticatedUser({
        authorization: "Bearer header.payload.signature"
      })
    ).resolves.toBeNull();
  });
});
