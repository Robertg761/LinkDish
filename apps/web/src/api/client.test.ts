import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiClientMocks = vi.hoisted(() => ({
  capturedOptions: null as { getHeaders: () => Promise<Record<string, string>> } | null,
  createCalls: 0,
  getSession: vi.fn(),
  /** The headers of each leaveHousehold request that went out. */
  sent: [] as Array<Record<string, string>>
}));

vi.mock("@linkdish/api-client", () => {
  return {
    createExtractorApiClient: (options: { getHeaders: () => Promise<Record<string, string>> }) => {
      apiClientMocks.capturedOptions = options;
      apiClientMocks.createCalls += 1;
      return {
        getSession: apiClientMocks.getSession,
        // Like the real client: credentials first, then the request goes out with them.
        leaveHousehold: async () => {
          apiClientMocks.sent.push(await options.getHeaders());
          return { household: null };
        }
      };
    },
    ExtractorApiError: class ExtractorApiError extends Error {
      public constructor(
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown
      ) {
        super(message);
        this.name = "ExtractorApiError";
      }
    }
  };
});

const blockStorageWrites = () => {
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    // Matches Safari Private Browsing / "block all cookies" behaviour.
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => null);
};

describe("api client headers in a storage-blocked browser", () => {
  beforeEach(() => {
    localStorage.clear();
    apiClientMocks.capturedOptions = null;
    apiClientMocks.createCalls = 0;
    apiClientMocks.getSession.mockReset().mockResolvedValue({ authenticated: false });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still builds request headers when localStorage throws on write", async () => {
    const { buildApiRequestHeaders } = await import("./client");

    blockStorageWrites();

    const headers = await buildApiRequestHeaders();

    expect(headers["x-linkdish-platform"]).toBe("web_app");
    expect(headers["x-linkdish-client-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(headers["x-linkdish-session-id"]).toBeTruthy();
  });

  it("keeps the client id and session id stable across requests without storage", async () => {
    const { buildApiRequestHeaders } = await import("./client");

    blockStorageWrites();

    const first = await buildApiRequestHeaders();
    const second = await buildApiRequestHeaders();

    expect(second["x-linkdish-client-id"]).toBe(first["x-linkdish-client-id"]);
    expect(second["x-linkdish-session-id"]).toBe(first["x-linkdish-session-id"]);
  });

  it("sends the registered auth token", async () => {
    const { buildApiRequestHeaders, registerAuthTokenProvider } = await import("./client");
    registerAuthTokenProvider(() => Promise.resolve("token_123"));

    expect((await buildApiRequestHeaders()).authorization).toBe("Bearer token_123");
  });
});

describe("lazy api client", () => {
  beforeEach(() => {
    apiClientMocks.capturedOptions = null;
    apiClientMocks.createCalls = 0;
    apiClientMocks.getSession.mockReset().mockResolvedValue({ authenticated: false });
    vi.resetModules();
  });

  it("loads the real client on the first request and reuses it", async () => {
    const { apiClient } = await import("./client");
    expect(apiClientMocks.createCalls).toBe(0);

    await expect(apiClient.getSession()).resolves.toEqual({ authenticated: false });
    await apiClient.getSession();

    expect(apiClientMocks.createCalls).toBe(1);
    expect(apiClientMocks.capturedOptions?.getHeaders).toBeTypeOf("function");
  });

  it("re-types API errors as the web ExtractorApiError", async () => {
    const packageModule = await import("@linkdish/api-client");
    const { apiClient, ExtractorApiError, isExtractorApiError } = await import("./client");
    apiClientMocks.getSession.mockRejectedValue(
      new packageModule.ExtractorApiError("Extractor API request failed.", 404, { message: "Gone" })
    );

    const error: unknown = await apiClient.getSession().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect(error).toMatchObject({ details: { message: "Gone" }, statusCode: 404 });
    expect(isExtractorApiError(error)).toBe(true);
  });

  it("turns synchronous validation throws into rejections", async () => {
    const { apiClient } = await import("./client");
    apiClientMocks.getSession.mockImplementation(() => {
      throw new Error("Invalid input");
    });

    const request = apiClient.getSession();

    await expect(request).rejects.toThrow("Invalid input");
  });
});

describe("requests bound to an account", () => {
  beforeEach(() => {
    apiClientMocks.sent = [];
    vi.resetModules();
  });

  /** account A signed in through Clerk session A, and a token provider that waits to answer. */
  const signedInAsA = async () => {
    const client = await import("./client");
    const { publishCurrentAccount } = await import("../auth/account-scope");
    const { publishClerkState } = await import("../auth/clerk-bridge");
    let answerToken: ((token: string) => void) | null = null;
    client.registerAuthTokenProvider(
      () =>
        new Promise<string>((resolve) => {
          answerToken = resolve;
        })
    );
    publishCurrentAccount("user_a");
    publishClerkState({ isLoaded: true, isSignedIn: true, sessionId: "sess_a", signInReady: true });

    return {
      ...client,
      /** Waits until the request asks for its token, then answers with `token`. */
      answerToken: async (token: string) => {
        await vi.waitFor(() => expect(answerToken).not.toBeNull());
        answerToken?.(token);
      },
      switchToB: () => {
        publishClerkState({
          isLoaded: true,
          isSignedIn: true,
          sessionId: "sess_b",
          signInReady: true
        });
      },
      publishCurrentAccount
    };
  };

  it("sends nothing when Clerk switches to another account before the token is in hand", async () => {
    const { answerToken, apiClient, asAccount, isAccountChangedError, switchToB } =
      await signedInAsA();

    const leaving = asAccount("user_a", () => apiClient.leaveHousehold());

    // Clerk switches to B while A's request is on its way (the token it then gets is B's).
    switchToB();
    await answerToken("token_b");

    const error: unknown = await leaving.catch((caught: unknown) => caught);
    expect(isAccountChangedError(error)).toBe(true);
    expect(apiClientMocks.sent).toEqual([]);
  });

  it("sends nothing once another account is shown as signed in", async () => {
    const { answerToken, apiClient, asAccount, isAccountChangedError, publishCurrentAccount } =
      await signedInAsA();

    const leaving = asAccount("user_a", () => apiClient.leaveHousehold());
    publishCurrentAccount(null);
    await answerToken("token_a");

    expect(isAccountChangedError(await leaving.catch((caught: unknown) => caught))).toBe(true);
    expect(apiClientMocks.sent).toEqual([]);
    // Refused up front, before loading anything, while the account is still gone.
    await expect(asAccount("user_a", () => apiClient.leaveHousehold())).rejects.toThrow(
      "Another account signed in"
    );
  });

  it("goes out as the account it was made for when nothing changed", async () => {
    const { answerToken, apiClient, asAccount } = await signedInAsA();

    const leaving = asAccount("user_a", () => apiClient.leaveHousehold());
    await answerToken("token_a");

    await expect(leaving).resolves.toEqual({ household: null });
    expect(apiClientMocks.sent).toEqual([
      expect.objectContaining({ authorization: "Bearer token_a" })
    ]);
  });

  it("leaves requests made outside asAccount alone", async () => {
    const { answerToken, apiClient, switchToB } = await signedInAsA();

    const leaving = apiClient.leaveHousehold();
    switchToB();
    await answerToken("token_b");

    await expect(leaving).resolves.toEqual({ household: null });
    expect(apiClientMocks.sent).toHaveLength(1);
  });
});

describe("requests bound to an account, carrying a Clerk token", () => {
  beforeEach(() => {
    apiClientMocks.sent = [];
    vi.resetModules();
  });

  const clerkToken = (sid: string) =>
    `${btoa('{"alg":"RS256"}')}.${btoa(JSON.stringify({ sid, sub: "clerk_user" })).replace(/=+$/u, "")}.sig`;

  const setUp = async (options: { clerkSession: string | null; token: string }) => {
    const client = await import("./client");
    const scope = await import("../auth/account-scope");
    const bridge = await import("../auth/clerk-bridge");
    let tokenRequests = 0;
    client.registerAuthTokenProvider(() => {
      tokenRequests += 1;
      return Promise.resolve(options.token);
    });
    bridge.publishClerkState({
      isLoaded: options.clerkSession !== null,
      isSignedIn: options.clerkSession !== null,
      sessionId: options.clerkSession,
      signInReady: true
    });
    /** Waits until the request has its token in hand, and a few turns more for its checks. */
    const tokenInHand = async () => {
      await vi.waitFor(() => expect(tokenRequests).toBeGreaterThan(0));

      for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
      }
    };
    return { ...client, ...scope, ...bridge, tokenInHand };
  };

  it("goes out at once with the session its account was confirmed under", async () => {
    const { apiClient, asAccount, publishCurrentAccount } = await setUp({
      clerkSession: "sess_a",
      token: clerkToken("sess_a")
    });
    publishCurrentAccount("user_a", "sess_a");

    await expect(asAccount("user_a", () => apiClient.leaveHousehold())).resolves.toEqual({
      household: null
    });
    expect(apiClientMocks.sent).toHaveLength(1);
  });

  it("isn't sent with another account's token when Clerk settles after a cached account was shown", async () => {
    // A cached account is shown while Clerk loads, and the request is made then.
    const {
      apiClient,
      asAccount,
      isAccountChangedError,
      publishClerkState,
      publishCurrentAccount,
      tokenInHand
    } = await setUp({ clerkSession: null, token: clerkToken("sess_b") });
    publishCurrentAccount("user_a");

    const leaving = asAccount("user_a", () => apiClient.leaveHousehold());
    // Clerk settles on another account's session, and the request gets that session's token
    // while the cached account is still shown (its session not checked yet).
    publishClerkState({ isLoaded: true, isSignedIn: true, sessionId: "sess_b", signInReady: true });
    await tokenInHand();
    expect(apiClientMocks.sent).toEqual([]);

    // The session turns out to be another account's.
    publishCurrentAccount("user_b", "sess_b");

    expect(isAccountChangedError(await leaving.catch((caught: unknown) => caught))).toBe(true);
    expect(apiClientMocks.sent).toEqual([]);
  });

  it("goes out once the settled session is confirmed as the cached account's own", async () => {
    const { apiClient, asAccount, publishClerkState, publishCurrentAccount, tokenInHand } =
      await setUp({ clerkSession: null, token: clerkToken("sess_a2") });
    publishCurrentAccount("user_a");

    const leaving = asAccount("user_a", () => apiClient.leaveHousehold());
    publishClerkState({
      isLoaded: true,
      isSignedIn: true,
      sessionId: "sess_a2",
      signInReady: true
    });
    await tokenInHand();
    expect(apiClientMocks.sent).toEqual([]);

    publishCurrentAccount("user_a", "sess_a2");

    await expect(leaving).resolves.toEqual({ household: null });
    expect(apiClientMocks.sent).toHaveLength(1);
  });

  it("gives up, sending nothing, if the session is never confirmed", async () => {
    vi.useFakeTimers();

    try {
      const { ACCOUNT_CONFIRMATION_WAIT_MS } = await import("./request-binding");
      const { apiClient, asAccount, isAccountChangedError, publishCurrentAccount } = await setUp({
        clerkSession: "sess_b",
        token: clerkToken("sess_b")
      });
      publishCurrentAccount("user_a");

      const leaving = asAccount("user_a", () => apiClient.leaveHousehold()).catch(
        (caught: unknown) => caught
      );
      await vi.advanceTimersByTimeAsync(ACCOUNT_CONFIRMATION_WAIT_MS);

      expect(isAccountChangedError(await leaving)).toBe(true);
      expect(apiClientMocks.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
