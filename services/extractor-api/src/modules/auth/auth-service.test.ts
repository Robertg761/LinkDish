import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importAuthService = async (env?: Record<string, string>) => {
  vi.resetModules();
  vi.stubEnv("AUTH_CODE_TTL_SECONDS", "600");
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "7776000");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

  for (const [key, value] of Object.entries(env ?? {})) {
    vi.stubEnv(key, value);
  }

  return import("./auth-service.js");
};

let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

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

beforeEach(() => {
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("auth-service", () => {
  it("creates a normalized email login code and session", async () => {
    const auth = await importAuthService();

    const codeResult = await auth.requestLoginCode(" USER+Family@Example.COM ");
    expect(codeResult).toMatchObject({
      email: "user+family@example.com",
      expiresInSeconds: 600
    });

    const session = await auth.verifyLoginCode("user+family@example.com", getLastLoginCode());
    expect(session.user.email).toBe("user+family@example.com");
    expect(session.user.displayName).toBeNull();
    expect(session.user.avatarEmoji).toBeNull();
    expect(session.sessionToken).toHaveLength(43);

    await expect(auth.getSessionByToken(session.sessionToken)).resolves.toMatchObject({
      user: session.user
    });
  });

  it("stores optional profile details during sign-in and profile edits", async () => {
    const auth = await importAuthService();

    await auth.requestLoginCode("profile@example.com");
    const session = await auth.verifyLoginCode("profile@example.com", getLastLoginCode(), {
      avatarEmoji: "🍳",
      displayName: " Family Cook "
    });

    expect(session.user).toMatchObject({
      avatarEmoji: "🍳",
      displayName: "Family Cook",
      email: "profile@example.com"
    });

    await expect(auth.getSessionByToken(session.sessionToken)).resolves.toMatchObject({
      user: {
        avatarEmoji: "🍳",
        displayName: "Family Cook"
      }
    });

    await expect(
      auth.updateUserProfileById(session.user.id, {
        avatarEmoji: null,
        displayName: "Recipe Keeper"
      })
    ).resolves.toMatchObject({
      avatarEmoji: null,
      displayName: "Recipe Keeper"
    });
  });

  it("rejects non-emoji profile avatars in service updates", async () => {
    const auth = await importAuthService();

    await auth.requestLoginCode("profile-text-avatar@example.com");
    const session = await auth.verifyLoginCode(
      "profile-text-avatar@example.com",
      getLastLoginCode()
    );

    await expect(
      auth.updateUserProfileById(session.user.id, {
        avatarEmoji: "LD"
      })
    ).rejects.toMatchObject({
      message: "Profile avatar must be a single emoji.",
      statusCode: 400
    });
  });

  it("rejects unsafe profile display names in service updates", async () => {
    const auth = await importAuthService();

    await auth.requestLoginCode("profile-control-name@example.com");
    const session = await auth.verifyLoginCode(
      "profile-control-name@example.com",
      getLastLoginCode()
    );

    await expect(
      auth.updateUserProfileById(session.user.id, {
        displayName: "Alice\nBob"
      })
    ).rejects.toMatchObject({
      message: "Profile display name cannot include control or invisible characters.",
      statusCode: 400
    });
  });

  it("rate limits code resends for the same email", async () => {
    const auth = await importAuthService();

    await auth.requestLoginCode("user@example.com");
    await expect(auth.requestLoginCode("USER@example.com")).rejects.toMatchObject({
      message: "Please wait a moment before requesting another sign-in code.",
      statusCode: 429
    });
  });

  it("supports a configured reusable app review login code", async () => {
    const auth = await importAuthService({
      APP_REVIEW_LOGIN_CODE: "123456",
      APP_REVIEW_LOGIN_EMAILS: " reviewer@example.com, backup-reviewer@example.com "
    });

    await expect(auth.requestLoginCode("Reviewer@Example.com")).resolves.toMatchObject({
      email: "reviewer@example.com",
      expiresInSeconds: 600
    });
    await expect(auth.requestLoginCode("reviewer@example.com")).resolves.toMatchObject({
      email: "reviewer@example.com",
      expiresInSeconds: 600
    });

    expect(consoleInfoSpy).not.toHaveBeenCalled();

    const session = await auth.verifyLoginCode("reviewer@example.com", "123456");
    expect(session.user.email).toBe("reviewer@example.com");
    expect(session.sessionToken).toHaveLength(43);
  });

  it("expires login codes and limits wrong-code attempts", async () => {
    vi.useFakeTimers({
      now: new Date("2026-05-11T10:00:00.000Z")
    });

    const auth = await importAuthService();

    await auth.requestLoginCode("expired@example.com");
    const expiredLoginCode = getLastLoginCode();
    await vi.advanceTimersByTimeAsync(601_000);
    await expect(
      auth.verifyLoginCode("expired@example.com", expiredLoginCode)
    ).rejects.toMatchObject({
      message: "That sign-in code has expired. Request a new code."
    });

    await auth.requestLoginCode("near-expiry@example.com");
    const nearExpiryLoginCode = getLastLoginCode();
    await vi.advanceTimersByTimeAsync(599_000);
    await expect(auth.verifyLoginCode("near-expiry@example.com", "000000")).rejects.toMatchObject({
      message: "That sign-in code is not correct."
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(
      auth.verifyLoginCode("near-expiry@example.com", nearExpiryLoginCode)
    ).rejects.toMatchObject({
      message: "That sign-in code has expired. Request a new code."
    });

    await auth.requestLoginCode("attempts@example.com");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.verifyLoginCode("attempts@example.com", "000000")).rejects.toMatchObject({
        message: "That sign-in code is not correct."
      });
    }

    await expect(auth.verifyLoginCode("attempts@example.com", "000000")).rejects.toMatchObject({
      message: "Too many attempts. Request a new sign-in code.",
      statusCode: 429
    });
  });

  it("logs out sessions and rejects deleted accounts", async () => {
    const auth = await importAuthService();

    await auth.requestLoginCode("delete@example.com");
    const firstSession = await auth.verifyLoginCode("delete@example.com", getLastLoginCode());
    expect(await auth.getSessionByToken(firstSession.sessionToken)).not.toBeNull();

    await auth.logoutSession(firstSession.sessionToken);
    expect(await auth.getSessionByToken(firstSession.sessionToken)).toBeNull();

    await auth.requestLoginCode("delete@example.com");
    const secondSession = await auth.verifyLoginCode("delete@example.com", getLastLoginCode());
    await auth.markUserDeleted(secondSession.user.id);
    expect(await auth.getSessionByToken(secondSession.sessionToken)).toBeNull();
    expect(await auth.getUserByEmail("delete@example.com")).toBeNull();
  });

  it("rolls back login code records when email delivery fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        headers: {
          "content-type": "application/json"
        },
        status: 503
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const auth = await importAuthService({
      AUTH_EMAIL_FROM: "LinkDish <login@example.com>",
      RESEND_API_KEY: "resend_test"
    });

    await expect(auth.requestLoginCode("sendfail@example.com")).rejects.toMatchObject({
      message: "LinkDish could not send a sign-in code right now.",
      statusCode: 503
    });
    await expect(auth.requestLoginCode("sendfail@example.com")).rejects.toMatchObject({
      message: "LinkDish could not send a sign-in code right now.",
      statusCode: 503
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
