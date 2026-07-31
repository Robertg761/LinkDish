import { afterEach, describe, expect, it, vi } from "vitest";

const importServices = async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "7776000");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

  const auth = await import("./auth-service.js");
  const identities = await import("./external-identity-service.js");

  return {
    auth,
    identities
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("external-identity-service", () => {
  it("creates a LinkDish user for a new verified external identity", async () => {
    const { auth, identities } = await importServices();

    const user = await identities.resolveExternalIdentity({
      email: " ClerkUser@Example.com ",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_user_1"
    });

    expect(user).toMatchObject({
      email: "clerkuser@example.com"
    });
    expect(user.id).toMatch(/^user_/u);
    await expect(auth.getUserByEmail("clerkuser@example.com")).resolves.toMatchObject({
      id: user.id
    });
  });

  it("links a verified external identity to an existing email-code user", async () => {
    const { auth, identities } = await importServices();

    const existingUser = await auth.upsertUserByEmail("existing@example.com");
    const resolvedUser = await identities.resolveExternalIdentity({
      email: "EXISTING@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_existing"
    });

    expect(resolvedUser).toEqual({
      avatarEmoji: null,
      displayName: null,
      email: "existing@example.com",
      id: existingUser.id
    });
  });

  it("resolves mapped identities without relying on the incoming email", async () => {
    const { identities } = await importServices();

    const firstResolvedUser = await identities.resolveExternalIdentity({
      email: "mapped@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_mapped"
    });
    const secondResolvedUser = await identities.resolveExternalIdentity({
      email: "changed@example.com",
      emailVerified: false,
      provider: "clerk",
      subject: "clerk_mapped"
    });

    expect(secondResolvedUser).toEqual(firstResolvedUser);
  });

  it("rejects unverified email for an unmapped identity", async () => {
    const { identities } = await importServices();

    await expect(
      identities.resolveExternalIdentity({
        email: "unverified@example.com",
        emailVerified: false,
        provider: "clerk",
        subject: "clerk_unverified"
      })
    ).rejects.toMatchObject({
      message: "A verified account email is required to sign in.",
      statusCode: 403
    });
  });

  it("tombstones deleted external identities and blocks silent recreation", async () => {
    const { auth, identities } = await importServices();

    const resolvedUser = await identities.resolveExternalIdentity({
      email: "deleted@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_deleted"
    });

    await auth.markUserDeleted(resolvedUser.id);
    await identities.tombstoneExternalIdentitiesForUser(resolvedUser.id);

    await expect(
      identities.resolveExternalIdentity({
        email: "deleted@example.com",
        emailVerified: true,
        provider: "clerk",
        subject: "clerk_deleted"
      })
    ).rejects.toMatchObject({
      message: "This LinkDish account has been deleted. Contact support to recover it.",
      statusCode: 410
    });
    await expect(auth.getUserByEmail("deleted@example.com")).resolves.toBeNull();
  });
});
