import React from "react";
import { Navigate } from "react-router-dom";

import { isClerkConfigured, useClerkBridge } from "../auth/clerk-bridge";
import { ButtonLink } from "../components/Button";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";

/**
 * /sso-callback: Clerk's OAuth redirect lands here. The Clerk bridge (mounted for this path)
 * renders Clerk's callback handler, which finishes sign-in and navigates on; this page only
 * shows progress, or a way back when Clerk can't load.
 */
export const SsoCallbackPage: React.FC = () => {
  const { status } = useClerkBridge();

  if (!isClerkConfigured()) {
    return <Navigate replace to="/account" />;
  }

  if (status === "failed") {
    return (
      <div className="container">
        <ErrorState
          actions={
            <ButtonLink to="/account" variant="primary">
              Back to sign in
            </ButtonLink>
          }
          message="We couldn't finish signing you in. Check your connection and try again."
          title="Sign-in didn't finish"
        />
      </div>
    );
  }

  return <LoadingState message="Signing you in…" />;
};
