import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";

const ONBOARDING_STORAGE_KEY = "linkdish:web:first-run-onboarding-seen:v1";

// Only first-time visitors (onboarding flag unset) ever download the sheet's UI chunk.
const FirstRunOnboardingDialog = lazyWithRetry(() =>
  import("./FirstRunOnboardingDialog").then((module) => ({
    default: module.FirstRunOnboardingDialog
  }))
);

export const FirstRunOnboardingSheet: React.FC = () => {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(localStorage.getItem(ONBOARDING_STORAGE_KEY) !== "true");
    } catch {
      setVisible(false);
    }
  }, []);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    } catch {
      // The sheet is still dismissible if storage is unavailable.
    }

    setVisible(false);
    void navigate("/");
  }, [navigate]);

  const hide = useCallback(() => {
    setVisible(false);
  }, []);

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
