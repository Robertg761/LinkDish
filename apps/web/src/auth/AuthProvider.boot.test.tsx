import { ExtractorApiError } from "@linkdish/api-client";
import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_CONFIG_CACHE_KEY, AUTH_USER_CACHE_KEY, readCachedAuthUser } from "./auth-cache";
import { setLegacySessionToken } from "./auth-storage";
import { AuthProvider, useAuth } from "./AuthProvider";

const apiClientMocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  getSession: vi.fn(),
  logout: vi.fn(),
  registerAuthTokenProvider: vi.fn()
}));

vi.mock("../api/client", () => ({
  apiClient: {
    getAuthConfig: apiClientMocks.getAuthConfig,
    getSession: apiClientMocks.getSession,
    logout: apiClientMocks.logout
  },
  registerAuthTokenProvider: apiClientMocks.registerAuthTokenProvider
}));

vi.mock("../analytics/client", () => ({
  trackWebEvent: vi.fn()
}));

const clerkMocks = vi.hoisted(() => ({
  auth: {
    getToken: vi.fn(),
    isLoaded: true,
    isSignedIn: false,
    signOut: vi.fn()
  },
  present: true,
  signIn: {
    isLoaded: true,
    signIn: { authenticateWithRedirect: vi.fn() }
  }
}));

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => {
    if (!clerkMocks.present) {
      throw new Error("useAuth can only be used within <ClerkProvider />");
    }
    return { ...clerkMocks.auth };
  },
  useSignIn: () => clerkMocks.signIn
}));

const user = { billingPlan: "plus" as const, email: "cook@example.com", id: "user_1" };

const legacyConfig = { authMode: "legacy_email_code", clerkEnabled: false, emailCodeEnabled: true };
const clerkConfig = { authMode: "clerk_primary", clerkEnabled: true, emailCodeEnabled: false };

const cacheConfig = (config: object) => {
  localStorage.setItem(
    AUTH_CONFIG_CACHE_KEY,
    JSON.stringify({ config, savedAt: "2026-09-01T00:00:00.000Z" })
  );
};

const cacheUser = (source: "clerk" | "legacy") => {
  localStorage.setItem(
    AUTH_USER_CACHE_KEY,
    JSON.stringify({ savedAt: "2026-09-01T00:00:00.000Z", source, user })
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

const renderAuth = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );

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
    seen.length = 0;
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test");
    apiClientMocks.getAuthConfig.mockReset();
    apiClientMocks.getSession.mockReset();
    apiClientMocks.logout.mockReset().mockResolvedValue({ status: "logged_out" });
    apiClientMocks.registerAuthTokenProvider.mockReset();
    clerkMocks.present = true;
    clerkMocks.auth.isLoaded = true;
    clerkMocks.auth.isSignedIn = false;
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

  it("does not wait for Clerk when no Clerk session can exist", async () => {
    setClerkSessionCookie("0");
    clerkMocks.auth.isLoaded = false;
    apiClientMocks.getAuthConfig.mockResolvedValue(clerkConfig);

    const { rerender } = renderAuth();
    await waitFor(() => expect(authText()).toBe("anonymous"));

    // Clerk's own answer still wins once it loads.
    clerkMocks.auth.isLoaded = true;
    clerkMocks.auth.isSignedIn = true;
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });
    rerender(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
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
});
