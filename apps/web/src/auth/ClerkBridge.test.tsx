import { act, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getClerkBridgeSnapshot, getClerkControls, resetClerkBridgeForTests } from "./clerk-bridge";
import { ClerkBridge } from "./ClerkBridge";

type RouterFn = (to: string) => unknown;

const clerk = vi.hoisted(() => ({
  auth: {
    getToken: vi.fn(),
    isLoaded: false,
    isSignedIn: false as boolean | undefined,
    sessionId: null as string | null,
    signOut: vi.fn()
  },
  provider: null as null | {
    publishableKey: string;
    routerPush: RouterFn;
    routerReplace: RouterFn;
  },
  signIn: {
    isLoaded: false,
    signIn: { authenticateWithRedirect: vi.fn() } as {
      authenticateWithRedirect: ReturnType<typeof vi.fn>;
    } | null
  }
}));

vi.mock("@clerk/clerk-react", () => ({
  AuthenticateWithRedirectCallback: () => <div data-testid="sso-handler" />,
  ClerkProvider: ({
    children,
    publishableKey,
    routerPush,
    routerReplace
  }: {
    children: React.ReactNode;
    publishableKey: string;
    routerPush: RouterFn;
    routerReplace: RouterFn;
  }) => {
    clerk.provider = { publishableKey, routerPush, routerReplace };
    return <>{children}</>;
  },
  useAuth: () => clerk.auth,
  useSignIn: () => clerk.signIn
}));

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <span data-testid="path">{`${location.pathname}${location.search}`}</span>;
};

const renderBridge = (handleSsoCallback = false) =>
  render(
    <MemoryRouter initialEntries={["/sso-callback"]}>
      <ClerkBridge handleSsoCallback={handleSsoCallback} publishableKey="pk_test_real" />
      <LocationProbe />
    </MemoryRouter>
  );

describe("ClerkBridge", () => {
  beforeEach(() => {
    resetClerkBridgeForTests();
    clerk.auth.isLoaded = false;
    clerk.auth.isSignedIn = undefined;
    clerk.auth.sessionId = null;
    clerk.auth.getToken.mockReset().mockResolvedValue("jwt_1");
    clerk.auth.signOut.mockReset().mockResolvedValue(undefined);
    clerk.signIn.isLoaded = false;
    clerk.signIn.signIn = { authenticateWithRedirect: vi.fn().mockResolvedValue(undefined) };
    clerk.provider = null;
  });

  afterEach(() => {
    resetClerkBridgeForTests();
  });

  it("mounts ClerkProvider with the key and reports Clerk's state to the store", () => {
    const { rerender } = renderBridge();

    expect(clerk.provider?.publishableKey).toBe("pk_test_real");
    expect(getClerkBridgeSnapshot()).toMatchObject({ isLoaded: false, status: "loading" });

    clerk.auth.isLoaded = true;
    clerk.auth.isSignedIn = true;
    clerk.auth.sessionId = "sess_1";
    clerk.signIn.isLoaded = true;
    const rerenderBridge = () =>
      rerender(
        <MemoryRouter initialEntries={["/sso-callback"]}>
          <ClerkBridge handleSsoCallback={false} publishableKey="pk_test_real" />
          <LocationProbe />
        </MemoryRouter>
      );
    rerenderBridge();

    expect(getClerkBridgeSnapshot()).toMatchObject({
      isLoaded: true,
      isSignedIn: true,
      sessionId: "sess_1",
      signInReady: true,
      status: "ready"
    });

    // Clerk switches straight to another account's session: still signed in, another session.
    clerk.auth.sessionId = "sess_2";
    rerenderBridge();

    expect(getClerkBridgeSnapshot()).toMatchObject({ isSignedIn: true, sessionId: "sess_2" });
  });

  it("registers Clerk's actions and removes them on unmount", async () => {
    clerk.auth.isLoaded = true;
    clerk.signIn.isLoaded = true;
    const { unmount } = renderBridge();
    const controls = getClerkControls();

    await expect(controls?.getToken()).resolves.toBe("jwt_1");
    clerk.auth.getToken.mockRejectedValueOnce(new Error("offline"));
    await expect(controls?.getToken()).resolves.toBeNull();

    await controls?.authenticateWithRedirect({
      redirectUrl: "https://app.example/sso-callback",
      redirectUrlComplete: "/",
      strategy: "oauth_google"
    });
    expect(clerk.signIn.signIn?.authenticateWithRedirect).toHaveBeenCalledWith({
      redirectUrl: "https://app.example/sso-callback",
      redirectUrlComplete: "/",
      strategy: "oauth_google"
    });

    await controls?.signOut();
    expect(clerk.auth.signOut).toHaveBeenLastCalledWith(undefined);
    await controls?.signOut("sess_1");
    expect(clerk.auth.signOut).toHaveBeenLastCalledWith({ sessionId: "sess_1" });

    unmount();
    expect(getClerkControls()).toBeNull();
  });

  it("renders the OAuth callback handler only on /sso-callback", () => {
    const { unmount } = renderBridge(false);
    expect(screen.queryByTestId("sso-handler")).not.toBeInTheDocument();
    unmount();

    renderBridge(true);
    expect(screen.getByTestId("sso-handler")).toBeInTheDocument();
  });

  it("lets Clerk navigate inside the app after the redirect", () => {
    renderBridge(true);

    act(() => {
      void clerk.provider?.routerPush(`${window.location.origin}/pricing?upgrade=plus`);
    });
    expect(screen.getByTestId("path")).toHaveTextContent("/pricing?upgrade=plus");

    act(() => {
      void clerk.provider?.routerReplace("/account");
    });
    expect(screen.getByTestId("path")).toHaveTextContent("/account");
  });
});
