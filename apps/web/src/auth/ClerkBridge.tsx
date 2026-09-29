import {
  AuthenticateWithRedirectCallback,
  ClerkProvider,
  useAuth,
  useSignIn
} from "@clerk/clerk-react";
import React, { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import {
  ClerkUnavailableError,
  publishClerkState,
  registerClerkControls,
  type ClerkRedirectParams
} from "./clerk-bridge";

/**
 * The only module that imports `@clerk/clerk-react`. It is loaded on demand (see clerk-bridge.ts)
 * and rendered next to the app, never around it: it reports Clerk's state and actions to the
 * bridge store and, on /sso-callback, finishes the OAuth redirect.
 */

const ClerkStatePublisher: React.FC = () => {
  const auth = useAuth();
  const signIn = useSignIn();
  const authRef = useRef(auth);
  const signInRef = useRef(signIn);
  authRef.current = auth;
  signInRef.current = signIn;

  useEffect(() => {
    registerClerkControls({
      authenticateWithRedirect: async (params: ClerkRedirectParams) => {
        const current = signInRef.current;

        if (!current.isLoaded || !current.signIn) {
          throw new ClerkUnavailableError();
        }

        await current.signIn.authenticateWithRedirect(params);
      },
      getToken: async () => {
        try {
          return (await authRef.current.getToken()) ?? null;
        } catch {
          return null;
        }
      },
      signOut: async (sessionId?: string) => {
        await authRef.current.signOut(sessionId ? { sessionId } : undefined);
      }
    });

    return () => {
      registerClerkControls(null);
    };
  }, []);

  const isLoaded = Boolean(auth.isLoaded);
  const isSignedIn = Boolean(auth.isSignedIn);
  const signInReady = Boolean(signIn.isLoaded && signIn.signIn);
  // A switch straight to another account's session leaves isSignedIn true; the session id says so.
  const sessionId = auth.sessionId ?? null;

  useEffect(() => {
    publishClerkState({ isLoaded, isSignedIn, sessionId, signInReady });
  }, [isLoaded, isSignedIn, sessionId, signInReady]);

  return null;
};

/** Same-origin destinations stay in the SPA; anything else is a real page load. */
const toAppPath = (to: string): string | null => {
  try {
    const url = new URL(to, window.location.href);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
};

interface ClerkBridgeProps {
  publishableKey: string;
  /** Render Clerk's OAuth callback handler (the page is /sso-callback). */
  handleSsoCallback: boolean;
}

export const ClerkBridge: React.FC<ClerkBridgeProps> = ({ handleSsoCallback, publishableKey }) => {
  const navigate = useNavigate();
  const routerPush = useCallback(
    (to: string) => {
      const path = toAppPath(to);

      if (path === null) {
        window.location.assign(to);
        return;
      }

      return navigate(path);
    },
    [navigate]
  );
  const routerReplace = useCallback(
    (to: string) => {
      const path = toAppPath(to);

      if (path === null) {
        window.location.replace(to);
        return;
      }

      return navigate(path, { replace: true });
    },
    [navigate]
  );

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      routerPush={routerPush}
      routerReplace={routerReplace}
    >
      <ClerkStatePublisher />
      {handleSsoCallback ? <AuthenticateWithRedirectCallback /> : null}
    </ClerkProvider>
  );
};
