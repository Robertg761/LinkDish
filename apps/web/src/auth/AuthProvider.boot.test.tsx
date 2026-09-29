import { ExtractorApiError } from "@linkdish/api-client";
import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentAccount } from "./account-scope";
import {
  AUTH_CONFIG_CACHE_KEY,
  AUTH_USER_CACHE_KEY,
  CLERK_SIGN_OUT_PENDING_KEY,
  readCachedAuthUser
} from "./auth-cache";
import { setLegacySessionToken } from "./auth-storage";
import { AuthProvider, CLERK_LOAD_TIMEOUT_MS, useAuth } from "./AuthProvider";
import {
  getClerkBridgeSnapshot,
  publishClerkState,
  registerClerkControls,
  requestClerk,
  resetClerkBridgeForTests
} from "./clerk-bridge";

const apiClientMocks = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  getAuthConfig: vi.fn(),
  getSession: vi.fn(),
  logout: vi.fn(),
  registerAuthTokenProvider: vi.fn()
}));

vi.mock("../api/client", () => ({
  apiClient: {
    deleteAccount: apiClientMocks.deleteAccount,
    getAuthConfig: apiClientMocks.getAuthConfig,
    getSession: apiClientMocks.getSession,
    logout: apiClientMocks.logout
  },
  registerAuthTokenProvider: apiClientMocks.registerAuthTokenProvider
}));

vi.mock("../analytics/client", () => ({
  trackWebEvent: vi.fn()
}));

/**
 * Clerk as the lazy bridge would report it. `present` = the bridge is mounted (requested);
 * AuthProvider never imports @clerk/clerk-react itself.
 */
const clerkMocks = {
  auth: {
    getToken: vi.fn<() => Promise<string | null>>(),
    isLoaded: true,
    isSignedIn: false,
    sessionId: "sess_1" as string | null,
    signOut: vi.fn<() => Promise<void>>()
  },
  present: true
};

/** Mirrors clerkMocks into the bridge store, as a mounted bridge would. */
const syncClerk = () => {
  if (!clerkMocks.present) {
    return;
  }

  requestClerk("session_hint");
  registerClerkControls({
    authenticateWithRedirect: vi.fn(),
    getToken: clerkMocks.auth.getToken,
    signOut: clerkMocks.auth.signOut
  });
  publishClerkState({
    isLoaded: clerkMocks.auth.isLoaded,
    isSignedIn: clerkMocks.auth.isSignedIn,
    sessionId: clerkMocks.auth.sessionId,
    signInReady: clerkMocks.auth.isLoaded
  });
};

const user = { billingPlan: "plus" as const, email: "cook@example.com", id: "user_1" };

const legacyConfig = { authMode: "legacy_email_code", clerkEnabled: false, emailCodeEnabled: true };
const clerkConfig = { authMode: "clerk_primary", clerkEnabled: true, emailCodeEnabled: false };

const cacheConfig = (config: object) => {
  localStorage.setItem(
    AUTH_CONFIG_CACHE_KEY,
    JSON.stringify({ config, savedAt: "2026-09-01T00:00:00.000Z" })
  );
};

/** A cached user; a Clerk one confirmed for `clerkSessionId` (the mock's session unless given). */
const cacheUser = (source: "clerk" | "legacy", clerkSessionId: string | null = "sess_1") => {
  localStorage.setItem(
    AUTH_USER_CACHE_KEY,
    JSON.stringify({
      ...(source === "clerk" && clerkSessionId ? { clerkSessionId } : {}),
      savedAt: "2026-09-01T00:00:00.000Z",
      source,
      user
    })
  );
};

const seen: Array<ReturnType<typeof useAuth>> = [];

const Probe: React.FC = () => {
  const auth = useAuth();
  seen.push(auth);

  return (
    <p data-testid="auth">
      {auth.loading ? "loading" : auth.user ? `user:${auth.user.email}` : "anonymous"}
    </p>
  );
};

const renderAuth = () => {
  syncClerk();

  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
};

const authText = () => screen.getByTestId("auth").textContent;

const setClerkSessionCookie = (value: string | null) => {
  document.cookie =
    value === null
      ? "__client_uat=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"
      : `__client_uat=${value}; path=/`;
};

describe("AuthProvider boot", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setClerkSessionCookie(null);
    resetClerkBridgeForTests();
    seen.length = 0;
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test");
    apiClientMocks.deleteAccount.mockReset();
    apiClientMocks.getAuthConfig.mockReset();
    apiClientMocks.getSession.mockReset();
    apiClientMocks.logout.mockReset().mockResolvedValue({ status: "logged_out" });
    apiClientMocks.registerAuthTokenProvider.mockReset();
    clerkMocks.present = true;
    clerkMocks.auth.isLoaded = true;
    clerkMocks.auth.isSignedIn = false;
    clerkMocks.auth.sessionId = "sess_1";
    clerkMocks.auth.getToken.mockReset().mockResolvedValue("clerk_jwt");
    clerkMocks.auth.signOut.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a cached signed-in user instantly and keeps them when the API is unreachable", async () => {
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockRejectedValue(new TypeError("Failed to fetch"));
    apiClientMocks.getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderAuth();

    expect(authText()).toBe("user:cook@example.com");
    expect(seen[0]?.authMode).toBe("clerk_primary");
    await waitFor(() => expect(apiClientMocks.getSession).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(authText()).toBe("user:cook@example.com");
    expect(readCachedAuthUser()?.user.email).toBe("cook@example.com");
  });

  it("doesn't show a cached user once Clerk settles on a session it wasn't confirmed for", async () => {
    // Cached for another session (another account signed in since, in another tab); the API
    // can't be reached to say whose session this one is.
    cacheConfig(clerkConfig);
    cacheUser("clerk", "sess_other");
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockRejectedValue(new TypeError("Failed to fetch"));
    apiClientMocks.getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderAuth();

    await waitFor(() => expect(apiClientMocks.getSession).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(authText()).not.toBe("user:cook@example.com");
    expect(getCurrentAccount()).toBeNull();
    expect(readCachedAuthUser()).toBeNull();
  });

  it("keeps showing a cached user whose session Clerk is still on", async () => {
    cacheConfig(clerkConfig);
    cacheUser("clerk", "sess_1");
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    let answer: (value: unknown) => void = () => undefined;
    apiClientMocks.getSession.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );

    renderAuth();
    await waitFor(() => expect(apiClientMocks.getSession).toHaveBeenCalled());
    // Still shown while it is checked again, and published as confirmed for that session.
    expect(authText()).toBe("user:cook@example.com");
    expect(getCurrentAccount()).toBe("user_1");

    await act(async () => {
      answer({ authenticated: true, user });
      await Promise.resolve();
    });
    expect(readCachedAuthUser()).toMatchObject({ clerkSessionId: "sess_1", source: "clerk" });
  });

  it("signs out only on a definitive answer (401)", async () => {
    cacheConfig(legacyConfig);
    cacheUser("legacy");
    setLegacySessionToken("legacy_token");
    apiClientMocks.getAuthConfig.mockResolvedValue(legacyConfig);
    apiClientMocks.getSession.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 401, { message: "Sign in" })
    );

    renderAuth();
    expect(authText()).toBe("user:cook@example.com");

    await waitFor(() => expect(authText()).toBe("anonymous"));
    expect(localStorage.getItem(AUTH_USER_CACHE_KEY)).toBeNull();
  });

  it("drops a refresh that answers for the account Clerk switched away from", async () => {
    cacheConfig(clerkConfig);
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();
    await waitFor(() => expect(authText()).toBe("user:cook@example.com"));

    // The first account refreshes; its answer is slow.
    let answerRefresh: (value: unknown) => void = () => undefined;
    apiClientMocks.getSession.mockReturnValueOnce(
      new Promise((resolve) => {
        answerRefresh = resolve;
      })
    );
    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = seen.at(-1)?.refreshUser();
    });

    // Clerk switches to another account, whose own session answers first.
    const next = { billingPlan: "free" as const, email: "next@example.com", id: "user_2" };
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user: next });
    clerkMocks.auth.sessionId = "sess_2";
    act(() => {
      syncClerk();
    });
    await waitFor(() => expect(authText()).toBe("user:next@example.com"));

    await act(async () => {
      answerRefresh({ authenticated: true, user });
      await refreshing;
    });

    expect(authText()).toBe("user:next@example.com");
    expect(getCurrentAccount()).toBe("user_2");
  });

  it("lets the last account go as soon as Clerk switches straight to another account's session", async () => {
    cacheConfig(clerkConfig);
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();
    await waitFor(() => expect(authText()).toBe("user:cook@example.com"));
    expect(getCurrentAccount()).toBe("user_1");

    // Another account signs in with Clerk (isSignedIn stays true); its session is still being
    // looked up, while requests already carry its token.
    const next = { billingPlan: "free" as const, email: "next@example.com", id: "user_2" };
    let answer: (value: unknown) => void = () => undefined;
    apiClientMocks.getSession.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    clerkMocks.auth.sessionId = "sess_2";
    act(() => {
      syncClerk();
    });

    expect(authText()).toBe("loading");
    expect(getCurrentAccount()).toBeNull();
    expect(seen.at(-1)?.credentialsKey).toBeNull();

    await act(async () => {
      answer({ authenticated: true, user: next });
      await Promise.resolve();
    });
    await waitFor(() => expect(authText()).toBe("user:next@example.com"));
    expect(getCurrentAccount()).toBe("user_2");
  });

  it("tells work that outlives its page (a toast's action) which account is signed in", async () => {
    cacheConfig(legacyConfig);
    cacheUser("legacy");
    setLegacySessionToken("legacy_token");
    apiClientMocks.getAuthConfig.mockResolvedValue(legacyConfig);
    apiClientMocks.getSession.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 401, { message: "Sign in" })
    );

    renderAuth();
    expect(getCurrentAccount()).toBe("user_1");

    await waitFor(() => expect(authText()).toBe("anonymous"));
    expect(getCurrentAccount()).toBeNull();
  });

  it("drops a cached legacy user whose token is gone", () => {
    cacheConfig(legacyConfig);
    cacheUser("legacy");
    apiClientMocks.getAuthConfig.mockReturnValue(new Promise(() => undefined));

    renderAuth();

    expect(authText()).toBe("anonymous");
    expect(apiClientMocks.getSession).not.toHaveBeenCalled();
  });

  it("stays loading until Clerk has loaded, then resolves the Clerk session", async () => {
    setClerkSessionCookie("1790000000");
    clerkMocks.auth.isLoaded = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    const { rerender } = renderAuth();
    await waitFor(() => expect(apiClientMocks.getAuthConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(authText()).toBe("loading");
    expect(apiClientMocks.getSession).not.toHaveBeenCalled();

    clerkMocks.auth.isLoaded = true;
    clerkMocks.auth.isSignedIn = true;
    act(() => {
      syncClerk();
    });
    rerender(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(authText()).toBe("user:cook@example.com"));
    expect(seen.some((value) => !value.loading && !value.user)).toBe(false);
    expect(readCachedAuthUser()).toMatchObject({ source: "clerk", user });
  });

  it("stops waiting for a Clerk script that never loads", async () => {
    vi.useFakeTimers();
    setClerkSessionCookie("1790000000");
    clerkMocks.auth.isLoaded = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);

    renderAuth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(authText()).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(authText()).toBe("anonymous");
  });

  it("does not wait for (or even load) Clerk when no Clerk session can exist", async () => {
    setClerkSessionCookie("0");
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);

    renderAuth();
    await waitFor(() => expect(authText()).toBe("anonymous"));
    expect(getClerkBridgeSnapshot().requested).toBe(false);

    // Clerk's own answer still wins once it loads (e.g. mounted for a sign-in).
    clerkMocks.present = true;
    clerkMocks.auth.isLoaded = true;
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });
    act(() => {
      syncClerk();
    });
    await waitFor(() => expect(authText()).toBe("user:cook@example.com"));
  });

  it("uses a cached config without waiting for the network", () => {
    cacheConfig(legacyConfig);
    apiClientMocks.getAuthConfig.mockReturnValue(new Promise(() => undefined));
    clerkMocks.present = false;

    renderAuth();

    expect(authText()).toBe("anonymous");
    expect(seen[0]?.emailCodeEnabled).toBe(true);
  });

  it("times out a hanging config request and still settles", async () => {
    vi.useFakeTimers();
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockReturnValue(new Promise(() => undefined));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderAuth();
    expect(authText()).toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 4_000 + 250 + 750 + 10);
    });

    expect(authText()).toBe("anonymous");
    expect(apiClientMocks.getAuthConfig).toHaveBeenCalledTimes(3);
  });

  it("keeps the context value stable across unrelated re-renders", async () => {
    cacheConfig(legacyConfig);
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(legacyConfig);

    const { rerender } = renderAuth();
    await act(async () => {
      await Promise.resolve();
    });
    const before = seen.at(-1);

    rerender(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    expect(seen.at(-1)).toBe(before);
  });

  /** The token provider AuthProvider registered with the API client. */
  const registeredTokenProvider = (): (() => Promise<string | null>) => {
    const provider = apiClientMocks.registerAuthTokenProvider.mock.calls.at(-1)?.[0] as
      | (() => Promise<string | null>)
      | undefined;

    if (!provider) {
      throw new Error("No token provider was registered.");
    }

    return provider;
  };

  it("waits for Clerk before handing out credentials for a cached Clerk user", async () => {
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    // The bridge mounts at boot for the cached Clerk user, but Clerk has not loaded yet.
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();

    expect(authText()).toBe("user:cook@example.com");
    expect(getClerkBridgeSnapshot()).toMatchObject({ isLoaded: false, requested: true });
    expect(seen.at(-1)?.credentialsReady).toBe(false);
    expect(seen.at(-1)?.credentialsKey).toBeNull();

    let token: string | null | undefined;
    void registeredTokenProvider()().then((value) => {
      token = value;
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Not "no token": the request waits for Clerk instead of going out anonymous.
    expect(token).toBeUndefined();

    clerkMocks.present = true;
    clerkMocks.auth.isSignedIn = true;
    act(() => {
      syncClerk();
    });

    await waitFor(() => expect(token).toBe("clerk_jwt"));
    await waitFor(() => expect(seen.at(-1)?.credentialsReady).toBe(true));
    expect(seen.at(-1)?.credentialsKey).toBe("clerk:user_1");
  });

  it("stops waiting for Clerk credentials after the load timeout, then refreshes them", async () => {
    vi.useFakeTimers();
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();

    let token: string | null | undefined;
    void registeredTokenProvider()().then((value) => {
      token = value;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLERK_LOAD_TIMEOUT_MS - 100);
    });
    expect(token).toBeUndefined();
    expect(seen.at(-1)?.credentialsReady).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(token).toBeNull();
    expect(authText()).toBe("user:cook@example.com");
    expect(seen.at(-1)?.credentialsReady).toBe(true);
    const keyWithoutClerk = seen.at(-1)?.credentialsKey;
    expect(keyWithoutClerk).not.toBeNull();

    // Later requests do not wait again for a Clerk script that is not coming.
    await expect(registeredTokenProvider()()).resolves.toBeNull();

    // Clerk loads after all: the credentials change, so account-scoped fetches run again.
    clerkMocks.present = true;
    clerkMocks.auth.isSignedIn = true;
    await act(async () => {
      syncClerk();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seen.at(-1)?.credentialsKey).toBe("clerk:user_1");
    expect(seen.at(-1)?.credentialsKey).not.toBe(keyWithoutClerk);
    await expect(registeredTokenProvider()()).resolves.toBe("clerk_jwt");
  });

  it("keeps a sign-out made before Clerk loaded when Clerk loads later", async () => {
    setClerkSessionCookie("1790000000");
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();
    expect(authText()).toBe("user:cook@example.com");

    let loggedOut = false;
    await act(async () => {
      void seen
        .at(-1)
        ?.logout()
        .then(() => {
          loggedOut = true;
        });
      await Promise.resolve();
    });
    expect(authText()).toBe("anonymous");
    expect(localStorage.getItem(AUTH_USER_CACHE_KEY)).toBeNull();

    // Clerk finishes loading with the session it still has.
    clerkMocks.present = true;
    clerkMocks.auth.isSignedIn = true;
    clerkMocks.auth.signOut.mockImplementation(() => {
      clerkMocks.auth.isSignedIn = false;
      syncClerk();
      return Promise.resolve();
    });
    await act(async () => {
      syncClerk();
      await Promise.resolve();
    });

    await waitFor(() => expect(loggedOut).toBe(true));
    expect(clerkMocks.auth.signOut).toHaveBeenCalledTimes(1);
    expect(authText()).toBe("anonymous");
    expect(localStorage.getItem(AUTH_USER_CACHE_KEY)).toBeNull();
    expect(localStorage.getItem(CLERK_SIGN_OUT_PENDING_KEY)).toBeNull();
    expect(apiClientMocks.getSession).not.toHaveBeenCalled();
  });

  it("finishes a sign-out that could not reach Clerk on the next visit", async () => {
    setClerkSessionCookie("1790000000");
    cacheConfig(clerkConfig);
    localStorage.setItem(CLERK_SIGN_OUT_PENDING_KEY, "2026-09-28T00:00:00.000Z");
    clerkMocks.auth.isSignedIn = true;
    clerkMocks.auth.signOut.mockImplementation(() => {
      clerkMocks.auth.isSignedIn = false;
      syncClerk();
      return Promise.resolve();
    });
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();

    await waitFor(() => expect(clerkMocks.auth.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(authText()).toBe("anonymous"));
    // No Clerk token for requests while the sign-out is still on its way.
    expect(apiClientMocks.getSession).not.toHaveBeenCalled();
    expect(localStorage.getItem(CLERK_SIGN_OUT_PENDING_KEY)).toBeNull();
  });

  it("clears the cached user on logout", async () => {
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();
    await waitFor(() => expect(apiClientMocks.getSession).toHaveBeenCalled());

    await act(async () => {
      await seen.at(-1)?.logout();
    });

    expect(authText()).toBe("anonymous");
    expect(localStorage.getItem(AUTH_USER_CACHE_KEY)).toBeNull();
    expect(clerkMocks.auth.signOut).toHaveBeenCalled();
  });

  it("signs out once the account is deleted", async () => {
    apiClientMocks.deleteAccount.mockResolvedValue({ status: "deleted" });
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderAuth();
    await waitFor(() => expect(apiClientMocks.getSession).toHaveBeenCalled());

    await act(async () => {
      await seen.at(-1)?.deleteAccount("cook@example.com");
    });

    expect(apiClientMocks.logout).toHaveBeenCalled();
    expect(authText()).toBe("anonymous");
  });

  it("never signs out an account that signed in while another was being deleted", async () => {
    let finishDelete: (value: unknown) => void = () => undefined;
    apiClientMocks.deleteAccount.mockReturnValue(
      new Promise((resolve) => {
        finishDelete = resolve;
      })
    );
    cacheConfig(clerkConfig);
    cacheUser("clerk");
    // The cached account is shown while Clerk loads.
    clerkMocks.present = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);
    const nextUser = { billingPlan: "free" as const, email: "next@example.com", id: "user_2" };
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user: nextUser });

    renderAuth();
    expect(authText()).toBe("user:cook@example.com");

    let deleted: Promise<void> | undefined;
    act(() => {
      deleted = seen.at(-1)?.deleteAccount("cook@example.com");
    });
    expect(apiClientMocks.deleteAccount).toHaveBeenCalledWith({
      confirmEmail: "cook@example.com"
    });

    // Clerk loads with a different account than the cached one.
    clerkMocks.present = true;
    clerkMocks.auth.isSignedIn = true;
    act(() => {
      syncClerk();
    });
    await waitFor(() => expect(authText()).toBe("user:next@example.com"));

    await act(async () => {
      finishDelete({ status: "deleted" });
      await deleted;
    });

    expect(authText()).toBe("user:next@example.com");
    expect(apiClientMocks.logout).not.toHaveBeenCalled();
    expect(clerkMocks.auth.signOut).not.toHaveBeenCalled();
    expect(readCachedAuthUser()?.user.email).toBe("next@example.com");
  });
});
