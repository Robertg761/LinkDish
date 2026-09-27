import React, {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from "react";

import { trackWebEvent } from "../../analytics/client";
import { useAuth } from "../../auth/AuthProvider";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { getWebBillingTier } from "../billing/web-billing";

export type UpgradeSheetTrigger =
  | "family_share_no_plan"
  | "fourth_import_month"
  | "import_limit"
  | "save_limit";

interface UpgradeSheetContextValue {
  requestUpgradeSheet: (trigger: UpgradeSheetTrigger) => boolean;
}

const UpgradeSheetContext = createContext<UpgradeSheetContextValue | null>(null);
const SESSION_KEY_PREFIX = "linkdish:web:upgrade-sheet-viewed:";

// The sheet UI and plans content load on the first request, keeping the provider tiny.
const UpgradeSheetDialog = lazyWithRetry(() =>
  import("./UpgradeSheetDialog").then((module) => ({ default: module.UpgradeSheetDialog }))
);

const hasViewedTrigger = (
  trigger: UpgradeSheetTrigger,
  viewedInMemory: Set<UpgradeSheetTrigger>
) => {
  if (viewedInMemory.has(trigger)) {
    return true;
  }

  try {
    return sessionStorage.getItem(`${SESSION_KEY_PREFIX}${trigger}`) === "true";
  } catch {
    return false;
  }
};

const markViewedTrigger = (
  trigger: UpgradeSheetTrigger,
  viewedInMemory: Set<UpgradeSheetTrigger>
) => {
  viewedInMemory.add(trigger);

  try {
    sessionStorage.setItem(`${SESSION_KEY_PREFIX}${trigger}`, "true");
  } catch {
    // Session storage is an enhancement; in-memory suppression still handles this page load.
  }
};

interface UpgradeSheetProviderProps {
  children: React.ReactNode;
}

export const UpgradeSheetProvider: React.FC<UpgradeSheetProviderProps> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [activeTrigger, setActiveTrigger] = useState<UpgradeSheetTrigger | null>(null);
  const viewedTriggersRef = useRef<Set<UpgradeSheetTrigger>>(new Set());
  const currentPlan = getWebBillingTier(user);

  const requestUpgradeSheet = useCallback(
    (trigger: UpgradeSheetTrigger) => {
      if (
        activeTrigger ||
        hasViewedTrigger(trigger, viewedTriggersRef.current) ||
        currentPlan !== "free"
      ) {
        return false;
      }

      markViewedTrigger(trigger, viewedTriggersRef.current);
      setActiveTrigger(trigger);
      trackWebEvent({
        eventName: "upgrade_viewed",
        routeOrScreen: window.location.pathname,
        properties: {
          trigger
        }
      });
      return true;
    },
    [activeTrigger, currentPlan]
  );

  const contextValue = useMemo(
    () => ({
      requestUpgradeSheet
    }),
    [requestUpgradeSheet]
  );

  const dismiss = useCallback(() => {
    setActiveTrigger(null);
  }, []);

  return (
    <UpgradeSheetContext.Provider value={contextValue}>
      {children}
      {activeTrigger ? (
        // Keyed by trigger so a sheet that failed to load can be offered again later.
        <OptionalChunkBoundary key={activeTrigger} name="Upgrade sheet" onError={dismiss}>
          <Suspense fallback={null}>
            <UpgradeSheetDialog
              currentPlan={currentPlan}
              isAuthenticated={isAuthenticated}
              onDismiss={dismiss}
              trigger={activeTrigger}
            />
          </Suspense>
        </OptionalChunkBoundary>
      ) : null}
    </UpgradeSheetContext.Provider>
  );
};

export const useUpgradeSheet = (): UpgradeSheetContextValue => {
  const context = useContext(UpgradeSheetContext);

  if (!context) {
    return {
      requestUpgradeSheet: () => false
    };
  }

  return context;
};
