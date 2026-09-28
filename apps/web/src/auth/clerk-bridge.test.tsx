import { act, render, screen, waitFor } from "@testing-library/react";
import React, { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "../app/providers";

import { useAuth } from "./AuthProvider";
import {
  ClerkUnavailableError,
  getClerkBridgeSnapshot,
  getBootClerkReason,
  requestClerk,
  resetClerkBridgeForTests
} from "./clerk-bridge";

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

const analyticsMocks = vi.hoisted(() => ({ trackWebError: vi.fn(), trackWebEvent: vi.fn() }));

vi.mock("../analytics/client", () => analyticsMocks);

/** Stand-in for the lazily loaded bridge chunk: reports a Clerk that loads immediately. */
const bridge = vi.hoisted(() => ({
  authenticateWithRedirect: vi.fn(),
  fail: false,
  getToken: vi.fn(),
  renders: [] as Array<{ handleSsoCallback: boolean; publishableKey: string }>,
  signOut: vi.fn(),
  signedIn: false
}));

vi.mock("./ClerkBridge", async () => {
  const store = await import("./clerk-bridge");
  const react = await import("react");

  const ClerkBridge = (props: { handleSsoCallback: boolean; publishableKey: string }) => {
    if (bridge.fail) {
      throw new Error("Failed to fetch dynamically imported module: /assets/ClerkBridge.js");
    }

    bridge.renders.push(props);

    react.useEffect(() => {
      store.registerClerkControls({
        authenticateWithRedirect: bridge.authenticateWithRedirect,
        getToken: bridge.getToken,
        signOut: bridge.signOut
      });
      store.publishClerkState({
        isLoaded: true,
        isSignedIn: bridge.signedIn,
        signInReady: true
      });

      return () => {
        store.registerClerkControls(null);
      };
    }, []);

    return react.createElement("div", {
      "data-sso": String(props.handleSsoCallback),
      "data-testid": "clerk-bridge"
    });
  };

  return { ClerkBridge };
});

const clerkConfig = { authMode: "clerk_primary", clerkEnabled: true, emailCodeEnabled: true };
const user = { billingPlan: "free" as const, email: "cook@example.com", id: "user_1" };

let latestAuth: ReturnType<typeof useAuth> | null = null;
let appMounts = 0;

const AuthProbe: React.FC = () => {
  latestAuth = useAuth();
  return null;
};

const App: React.FC = () => {
  useEffect(() => {
    appMounts += 1;
  }, []);

  return <AuthProbe />;
};

const renderApp = (path = "/") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders>
        <App />
      </AppProviders>
    </MemoryRouter>
  );

const setClerkSessionCookie = (value: string | null) => {
  document.cookie =
    value === null
      ? "__client_uat=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"
      : `__client_uat=${value}; path=/`;
};

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("lazy Clerk bridge", () => {
  beforeEach(() => {
    localStorage.clear();
    setClerkSessionCookie(null);
    resetClerkBridgeForTests();
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_bridge");
    apiClientMocks.getAuthConfig.mockReset().mockResolvedValue(clerkConfig);
    apiClientMocks.getSession.mockReset().mockResolvedValue({ authenticated: false });
    apiClientMocks.logout.mockReset().mockResolvedValue({ status: "logged_out" });
    apiClientMocks.registerAuthTokenProvider.mockReset();
    analyticsMocks.trackWebEvent.mockReset();
    analyticsMocks.trackWebError.mockReset();
    bridge.authenticateWithRedirect.mockReset().mockResolvedValue(undefined);
    bridge.getToken.mockReset().mockResolvedValue(null);
    bridge.signOut.mockReset().mockResolvedValue(undefined);
    bridge.renders = [];
    bridge.fail = false;
    bridge.signedIn = false;
    latestAuth = null;
    appMounts = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setClerkSessionCookie(null);
    resetClerkBridgeForTests();
    vi.restoreAllMocks();
  });

  it("never mounts without a publishable key, even with a session cookie or on /sso-callback", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    setClerkSessionCookie("1790000000");

    renderApp("/sso-callback");
    await settle();
    act(() => {
      requestClerk("sign_in");
    });
    await settle();

    expect(getBootClerkReason()).toBeNull();
    expect(getClerkBridgeSnapshot().requested).toBe(false);
    expect(screen.queryByTestId("clerk-bridge")).not.toBeInTheDocument();
    expect(bridge.renders).toHaveLength(0);
    expect(latestAuth?.hasClerkPublishableKey).toBe(false);
    expect(latestAuth?.clerkReady).toBe(false);
  });

  it("stays unmounted for a visitor with no Clerk session", async () => {
    renderApp("/");
    await settle();

    expect(getClerkBridgeSnapshot()).toMatchObject({ reason: null, requested: false });
    expect(screen.queryByTestId("clerk-bridge")).not.toBeInTheDocument();
    // Google sign-in can still start: Clerk loads on demand.
    expect(latestAuth?.clerkReady).toBe(true);
    expect(latestAuth?.loading).toBe(false);
  });

  it("mounts at boot when Clerk's session cookie says someone may be signed in", async () => {
    setClerkSessionCookie("1790000000");
    bridge.signedIn = true;
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderApp("/");

    expect(await screen.findByTestId("clerk-bridge")).toHaveAttribute("data-sso", "false");
    expect(getClerkBridgeSnapshot().reason).toBe("session_hint");
    expect(bridge.renders[0]?.publishableKey).toBe("pk_test_bridge");
    await waitFor(() => expect(latestAuth?.user?.email).toBe("cook@example.com"));
  });

  it("mounts at boot for a cached Clerk user", async () => {
    localStorage.setItem(
      "linkdish:web:auth-user:v1",
      JSON.stringify({ savedAt: "2026-09-01T00:00:00.000Z", source: "clerk", user })
    );

    renderApp("/");

    expect(await screen.findByTestId("clerk-bridge")).toBeInTheDocument();
    expect(getClerkBridgeSnapshot().reason).toBe("cached_user");
  });

  it("renders Clerk's OAuth callback handler on /sso-callback", async () => {
    renderApp("/sso-callback");

    expect(await screen.findByTestId("clerk-bridge")).toHaveAttribute("data-sso", "true");
    expect(getClerkBridgeSnapshot().reason).toBe("sso_callback");
  });

  it("mounts when Google sign-in starts, then redirects through Clerk", async () => {
    renderApp("/");
    await settle();
    expect(screen.queryByTestId("clerk-bridge")).not.toBeInTheDocument();

    await act(async () => {
      await latestAuth?.loginWithGoogle("/pricing?upgrade=plus");
    });

    expect(screen.getByTestId("clerk-bridge")).toBeInTheDocument();
    expect(getClerkBridgeSnapshot().reason).toBe("sign_in");
    expect(bridge.authenticateWithRedirect).toHaveBeenCalledWith({
      redirectUrl: `${window.location.origin}/sso-callback`,
      redirectUrlComplete: "/pricing?upgrade=plus",
      strategy: "oauth_google"
    });
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "web_sign_in_started",
        properties: { auth_mode: "clerk_google" }
      })
    );
  });

  it("warms Clerk up while a signed-out visitor is on the sign-in screen", async () => {
    renderApp("/account");

    expect(await screen.findByTestId("clerk-bridge")).toBeInTheDocument();
    expect(getClerkBridgeSnapshot().reason).toBe("sign_in_view");
  });

  it("warms Clerk up for the sign-in screen only when the server enables Clerk sign-in", async () => {
    apiClientMocks.getAuthConfig.mockResolvedValue({ ...clerkConfig, clerkEnabled: false });
    renderApp("/account");
    await settle();

    act(() => {
      latestAuth?.prepareGoogleSignIn();
    });
    expect(getClerkBridgeSnapshot().requested).toBe(false);
    expect(screen.queryByTestId("clerk-bridge")).not.toBeInTheDocument();
  });

  it("does not remount the app when the bridge mounts", async () => {
    renderApp("/");
    await settle();
    expect(appMounts).toBe(1);

    act(() => {
      latestAuth?.prepareGoogleSignIn();
    });

    expect(await screen.findByTestId("clerk-bridge")).toBeInTheDocument();
    expect(getClerkBridgeSnapshot().reason).toBe("sign_in_view");
    expect(appMounts).toBe(1);
  });

  it("wires Clerk's session token into API requests", async () => {
    setClerkSessionCookie("1790000000");
    bridge.signedIn = true;
    bridge.getToken.mockResolvedValue("clerk_jwt");
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderApp("/");
    await screen.findByTestId("clerk-bridge");
    await waitFor(() => expect(latestAuth?.isAuthenticated).toBe(true));

    const provider = apiClientMocks.registerAuthTokenProvider.mock.calls.at(-1)?.[0] as
      | (() => Promise<string | null>)
      | undefined;

    await expect(provider?.()).resolves.toBe("clerk_jwt");
  });

  it("signs out of Clerk on logout once it is loaded", async () => {
    setClerkSessionCookie("1790000000");
    bridge.signedIn = true;
    apiClientMocks.getSession.mockResolvedValue({ authenticated: true, user });

    renderApp("/");
    await waitFor(() => expect(latestAuth?.isAuthenticated).toBe(true));

    await act(async () => {
      await latestAuth?.logout();
    });

    expect(bridge.signOut).toHaveBeenCalled();
    expect(latestAuth?.isAuthenticated).toBe(false);
  });

  it("reports Google sign-in as unavailable when the bridge cannot load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    bridge.fail = true;
    renderApp("/");
    await settle();

    let failure: unknown = null;
    await act(async () => {
      await latestAuth?.loginWithGoogle("/").catch((error: unknown) => {
        failure = error;
      });
    });

    expect(failure).toBeInstanceOf(ClerkUnavailableError);
    expect(getClerkBridgeSnapshot().status).toBe("failed");
    expect(latestAuth?.clerkReady).toBe(false);
    expect(bridge.authenticateWithRedirect).not.toHaveBeenCalled();
  });
});
