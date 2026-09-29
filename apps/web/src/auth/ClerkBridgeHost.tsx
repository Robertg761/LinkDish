import React, { Suspense, useEffect } from "react";
import { useLocation } from "react-router-dom";

import { lazyWithRetry, retryFailedLazyImports } from "../platform/lazy";
import { OptionalChunkBoundary } from "../platform/OptionalChunkBoundary";

import { useAuth } from "./AuthProvider";
import {
  getClerkPublishableKey,
  markClerkBridgeFailed,
  requestClerk,
  SSO_CALLBACK_PATH,
  useClerkBridge
} from "./clerk-bridge";

/** Where people sign in (AccountPage shows the sign-in screen to signed-out visitors). */
const SIGN_IN_PATH = "/account";

const ClerkBridge = lazyWithRetry(() =>
  import("./ClerkBridge").then((module) => ({ default: module.ClerkBridge }))
);

/**
 * Renders the lazily loaded Clerk bridge next to the app once something asks for Clerk. It sits
 * inside the router (Clerk navigates with it) but outside the page tree, so mounting it never
 * remounts pages. Renders nothing without a publishable key.
 */
export const ClerkBridgeHost: React.FC = () => {
  const { attempt, requested } = useClerkBridge();
  const { pathname } = useLocation();
  const { clerkEnabled, isAuthenticated, loading, prepareGoogleSignIn } = useAuth();
  const publishableKey = getClerkPublishableKey();
  const onSsoCallback = pathname === SSO_CALLBACK_PATH;
  const onSignInScreen = pathname === SIGN_IN_PATH && !loading && !isAuthenticated && clerkEnabled;

  useEffect(() => {
    if (onSsoCallback) {
      requestClerk("sso_callback");
    }
  }, [onSsoCallback]);

  // The sign-in screen is showing: load Clerk now so "Continue with Google" responds at once.
  useEffect(() => {
    if (onSignInScreen) {
      prepareGoogleSignIn();
    }
  }, [onSignInScreen, prepareGoogleSignIn]);

  // Asked for again after the chunk failed: let the lazy import try again.
  useEffect(() => {
    if (attempt > 0) {
      retryFailedLazyImports();
    }
  }, [attempt]);

  if (!requested || !publishableKey) {
    return null;
  }

  return (
    <OptionalChunkBoundary key={attempt} name="Clerk" onError={markClerkBridgeFailed}>
      <Suspense fallback={null}>
        <ClerkBridge handleSsoCallback={onSsoCallback} publishableKey={publishableKey} />
      </Suspense>
    </OptionalChunkBoundary>
  );
};
