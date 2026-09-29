import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

import { isOnboardingSuppressedRoute, ONBOARDING_STORAGE_KEY } from "./onboarding-routes";

// Only first-time visitors (onboarding flag unset) ever download the sheet's UI chunk.
const FirstRunOnboardingDialog = lazyWithRetry(() =>
  import("./FirstRunOnboardingDialog").then((module) => ({
    default: module.FirstRunOnboardingDialog
  }))
);

/** A beat after first paint, so the page is there before the sheet slides over it. */
const SHOW_DELAY_MS = 450;

/**
 * The first-run welcome. It is decided once, on the page the visitor arrived at: deep links
 * never get it (see onboarding-routes), and dismissing it never navigates anywhere.
 */
export const FirstRunOnboardingSheet: React.FC = () => {
  const location = useLocation();
  const [eligible] = useState(
    () =>
      safeGetItem(ONBOARDING_STORAGE_KEY) !== "true" &&
      !isOnboardingSuppressedRoute(location.pathname, location.search)
  );
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!eligible) {
      return;
    }

    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [eligible]);

  const finish = useCallback(() => {
    // The sheet still closes when storage is unavailable.
    safeSetItem(ONBOARDING_STORAGE_KEY, "true");
    setVisible(false);
  }, []);

  const hide = useCallback(() => setVisible(false), []);

  if (!visible) {
    return null;
  }

  return (
    <OptionalChunkBoundary name="Onboarding" onError={hide}>
      <Suspense fallback={null}>
        <FirstRunOnboardingDialog onFinish={finish} />
      </Suspense>
    </OptionalChunkBoundary>
  );
};
