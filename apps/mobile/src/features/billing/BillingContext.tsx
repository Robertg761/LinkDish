import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { AppState, Platform } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { mobileEnv } from "../../config/env";
import { useAccount } from "../account/AccountContext";

import { isLaunchProductAvailable } from "./launch-offering";
import { billingPlans, type BillingPlan, type BillingTier, type PaidBillingTier } from "./plans";
import {
  addRevenueCatCustomerInfoListener,
  configureRevenueCat,
  getActiveRevenueCatBillingTier,
  getRevenueCatOffering,
  getNextRevenueCatExpiration,
  refreshRevenueCatCustomerInfo,
  getRevenueCatPackageBillingTier,
  getRevenueCatPackagePeriodLabel,
  getOrCreateRevenueCatAppUserId,
  hasActiveRevenueCatPaidPlan,
  isRevenueCatPurchaseCancelled,
  loginRevenueCatAccount,
  logoutRevenueCatAccount,
  purchaseRevenueCatPackage,
  restoreRevenueCatPurchases,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage
} from "./revenuecat";
import {
  getRemainingImports,
  getRemainingStrongExtractions,
  normalizeBillingUsageForTier,
  parseBillingState,
  serializeBillingState,
  type BillingState
} from "./store";

export interface BillingGateResult {
  allowed: boolean;
  message?: string;
  title?: string;
}

type PurchaseStatus = "idle" | "loading" | "purchasing" | "restoring" | "unavailable";

interface BillingContextValue {
  activatePlanPreview: (tier: PaidBillingTier) => void;
  activePaidTier: PaidBillingTier | null;
  canStartImport: () => BillingGateResult;
  canStartStrongExtraction: () => BillingGateResult;
  customerInfo: CustomerInfo | null;
  hasActivePaidPlan: boolean;
  hasLoadedBilling: boolean;
  offering: PurchasesOffering | null;
  plan: BillingPlan;
  purchaseError: string | null;
  restoreMessage: string | null;
  purchasePackage: (selectedPackage: PurchasesPackage) => Promise<void>;
  purchaseStatus: PurchaseStatus;
  remainingImports: number;
  remainingStrongExtractions: number;
  resetToFreePreview: () => void;
  restorePurchases: () => Promise<void>;
  revenueCatAppUserId: string | null;
  revenueCatConfigured: boolean;
  spendImport: () => BillingGateResult;
  spendStrongExtraction: () => BillingGateResult;
  tier: BillingTier;
  usage: BillingState["usage"];
}

const BillingContext = createContext<BillingContextValue | null>(null);
const BILLING_STORAGE_KEY = "linkdish.billing";

const getImportLimitMessage = (plan: BillingPlan): BillingGateResult => ({
  allowed: false,
  title: plan.id === "free" ? "Free recipe imports used" : "Monthly recipe imports used",
  message:
    plan.id === "free"
      ? (Platform.OS === "ios"
        ? "You have used your free recipe imports. LinkDish Plus includes 100 imports each month."
        : "You have used your free recipe imports. LinkDish Plus includes 100 imports each month, and Family includes 250.")
      : `You have used this month's ${plan.displayName} recipe imports.`
});

const getStrongExtractionLimitMessage = (plan: BillingPlan): BillingGateResult => ({
  allowed: false,
  title: plan.id === "free" ? "Free recipe imports used" : "Monthly recipe imports used",
  message:
    plan.id === "free"
      ? (Platform.OS === "ios"
        ? "You have used your free recipe imports. LinkDish Plus includes 100 imports each month."
        : "You have used your free recipe imports. LinkDish Plus includes 100 imports each month, and Family includes 250.")
      : `You have used this month's ${plan.displayName} recipe imports.`
});

const accountRequiredPurchaseError =
  "Sign in before choosing a paid plan so your purchase is connected to your LinkDish quota.";
const accountRequiredRestoreError =
  "Sign in before restoring purchases so LinkDish can connect your store purchase to your account.";

const canUseLocalPlanPreview = (): boolean =>
  process.env.NODE_ENV !== "production" && mobileEnv.localPlanPreviewEnabled;

const parseInitialBillingState = (storedState: string | null): BillingState => {
  const parsedState = parseBillingState(storedState);

  if (!canUseLocalPlanPreview() || parsedState.tier !== "free") {
    return parsedState;
  }

  return {
    ...parsedState,
    tier: "family"
  };
};

export const BillingProvider = ({ children }: PropsWithChildren) => {
  const { hasLoadedAccount, refreshAccount, user } = useAccount();
  const [hasLoadedBilling, setHasLoadedBilling] = useState(false);
  const [billingState, setBillingState] = useState<BillingState>(() => parseBillingState(null));
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [offering, setOffering] = useState<PurchasesOffering | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<PurchaseStatus>("loading");
  const [localRevenueCatAppUserId, setLocalRevenueCatAppUserId] = useState<string | null>(null);
  const [revenueCatAppUserId, setRevenueCatAppUserId] = useState<string | null>(null);
  const revenueCatAppUserIdRef = useRef<string | null>(null);
  const [revenueCatConfigured, setRevenueCatConfigured] = useState(false);
  const [customerInfoAppUserId, setCustomerInfoAppUserId] = useState<string | null>(null);

  const accountRef = useRef({ userId: user?.id, refreshAccount });
  accountRef.current = { userId: user?.id, refreshAccount };
  const mountedRef = useRef(true);
  const operationRef = useRef(false);
  const refreshQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSyncRef = useRef<{ userId: string; tier: PaidBillingTier; restore: boolean } | null>(
    null
  );
  const backgroundRefreshRef = useRef<(force?: boolean) => void>(() => undefined);

  // Serialize account reads so a pre-purchase response cannot overwrite a post-purchase plan.
  const refreshVerifiedAccount = useCallback((userId: string) => {
    const request = refreshQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!mountedRef.current || accountRef.current.userId !== userId) return null;
        const nextUser = await accountRef.current.refreshAccount({ silent: true });
        if (!mountedRef.current || accountRef.current.userId !== userId) return null;
        return nextUser;
      });
    refreshQueueRef.current = request;
    return request;
  }, []);

  const syncStoreResult = useCallback(
    async (info: CustomerInfo, userId: string, restore: boolean) => {
      const expectedTier = getActiveRevenueCatBillingTier(info);
      let synced = false;
      // The store receipt can arrive just ahead of the server's RevenueCat read.
      for (const delay of [0, 1000, 2000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (!mountedRef.current || accountRef.current.userId !== userId) return;
        try {
          const account = await refreshVerifiedAccount(userId);
          synced =
            Boolean(account) &&
            (!expectedTier ||
              account?.billingPlan === expectedTier ||
              (expectedTier === "plus" && account?.billingPlan === "family"));
          if (synced) break;
        } catch {
          // A successful store transaction must never be presented as a failed purchase.
        }
      }
      if (!mountedRef.current || accountRef.current.userId !== userId) return;
      if (restore) {
        setRestoreMessage(
          !hasActiveRevenueCatPaidPlan(info)
            ? "No active LinkDish purchase was found for this store account."
            : synced
              ? "Purchases restored. Your paid access is ready."
              : "Purchases restored with your store, but LinkDish could not refresh your access yet. Check your connection; we’ll retry automatically. You do not need to purchase again."
        );
      } else if (!synced) {
        setPurchaseError(
          "Your purchase succeeded, but LinkDish could not refresh your access yet. Check your connection; we’ll retry automatically. You do not need to purchase again."
        );
      }
      pendingSyncRef.current =
        !synced && expectedTier ? { userId, tier: expectedTier, restore } : null;
    },
    [refreshVerifiedAccount]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setRestoreMessage(null);
    setPurchaseError(null);
    pendingSyncRef.current = null;
  }, [user?.id]);

  useEffect(() => {
    const pending = pendingSyncRef.current;
    if (
      pending &&
      pending.userId === user?.id &&
      (user?.billingPlan === pending?.tier ||
        (pending?.tier === "plus" && user?.billingPlan === "family"))
    ) {
      if (pending.restore) setRestoreMessage("Purchases restored. Your paid access is ready.");
      else setPurchaseError(null);
      pendingSyncRef.current = null;
    }
  }, [user?.billingPlan, user?.id]);

  const updateRevenueCatAppUserId = (appUserId: string | null) => {
    revenueCatAppUserIdRef.current = appUserId;
    setRevenueCatAppUserId(appUserId);
  };

  const updateCustomerInfo = (nextCustomerInfo: CustomerInfo | null, appUserId: string | null) => {
    setCustomerInfo(nextCustomerInfo);
    setCustomerInfoAppUserId(appUserId);
  };

  useEffect(() => {
    let isMounted = true;
    let removeCustomerInfoListener: (() => void) | null = null;

    const hydrateBillingState = async () => {
      let localAppUserId: string | null = null;

      if (!hasLoadedAccount) {
        return;
      }

      try {
        setHasLoadedBilling(false);
        const storedState = await AsyncStorage.getItem(BILLING_STORAGE_KEY);
        localAppUserId = await getOrCreateRevenueCatAppUserId();

        if (!isMounted) {
          return;
        }

        setBillingState(parseInitialBillingState(storedState));
        setLocalRevenueCatAppUserId(localAppUserId);
        updateRevenueCatAppUserId(localAppUserId);

        if (canUseLocalPlanPreview()) {
          updateCustomerInfo(null, null);
          setOffering(null);
          setRevenueCatConfigured(false);
          setPurchaseError(null);
          setPurchaseStatus("unavailable");
          return;
        }

        const revenueCatState = await configureRevenueCat(localAppUserId);

        if (!isMounted) {
          return;
        }

        updateCustomerInfo(
          revenueCatState.customerInfo,
          revenueCatState.appUserId ?? localAppUserId
        );
        updateRevenueCatAppUserId(revenueCatState.appUserId ?? localAppUserId);
        setRevenueCatConfigured(revenueCatState.configured);

        if (!revenueCatState.configured) {
          setPurchaseStatus("unavailable");
          return;
        }

        removeCustomerInfoListener = await addRevenueCatCustomerInfoListener((nextCustomerInfo) => {
          if (isMounted) {
            updateCustomerInfo(nextCustomerInfo, revenueCatAppUserIdRef.current);
            const userId = accountRef.current.userId;
            if (userId && userId === revenueCatAppUserIdRef.current && !operationRef.current) {
              void refreshVerifiedAccount(userId).catch(() => undefined);
            }
          }
        });

        const loadedOffering = await getRevenueCatOffering();

        if (isMounted) {
          setOffering(loadedOffering);
          setPurchaseStatus("idle");
        }
      } catch (error) {
        console.warn("Failed to load billing state or purchases.", error);
        if (localAppUserId) {
          updateRevenueCatAppUserId(localAppUserId);
        }
        updateCustomerInfo(null, null);
        setRevenueCatConfigured(false);
        setPurchaseError("Purchases are unavailable right now. Please try again later.");
        setPurchaseStatus("unavailable");
      } finally {
        if (isMounted) {
          setHasLoadedBilling(true);
        }
      }
    };

    void hydrateBillingState();

    return () => {
      isMounted = false;
      removeCustomerInfoListener?.();
    };
  }, [hasLoadedAccount, refreshVerifiedAccount]);

  useEffect(() => {
    if (!hasLoadedAccount || !revenueCatConfigured) {
      return;
    }

    let isMounted = true;

    const syncRevenueCatIdentity = async () => {
      try {
        const localAppUserId = await getOrCreateRevenueCatAppUserId();
        if (isMounted) {
          setLocalRevenueCatAppUserId(localAppUserId);
        }

        if (user?.id) {
          if (revenueCatAppUserId === user.id && customerInfoAppUserId === user.id) {
            return;
          }

          const nextCustomerInfo = await loginRevenueCatAccount(user.id);

          if (isMounted) {
            updateCustomerInfo(nextCustomerInfo, user.id);
            updateRevenueCatAppUserId(user.id);
          }

          return;
        }

        if (revenueCatAppUserId === localAppUserId && customerInfoAppUserId === localAppUserId) {
          return;
        }

        const nextCustomerInfo = await logoutRevenueCatAccount(localAppUserId);

        if (isMounted) {
          updateCustomerInfo(nextCustomerInfo, localAppUserId);
          updateRevenueCatAppUserId(localAppUserId);
        }
      } catch (error) {
        console.warn("Failed to sync RevenueCat account identity.", error);
      }
    };

    void syncRevenueCatIdentity();

    return () => {
      isMounted = false;
    };
  }, [
    customerInfoAppUserId,
    hasLoadedAccount,
    revenueCatAppUserId,
    revenueCatConfigured,
    user?.billingPlan,
    user?.id
  ]);

  useEffect(() => {
    if (!hasLoadedBilling) {
      return;
    }

    const persistBillingState = async () => {
      try {
        await AsyncStorage.setItem(BILLING_STORAGE_KEY, serializeBillingState(billingState));
      } catch (error) {
        console.warn("Failed to persist billing state.", error);
      }
    };

    void persistBillingState();
  }, [billingState, hasLoadedBilling]);

  useEffect(() => {
    const userId = user?.id;
    if (!hasLoadedAccount || !userId || canUseLocalPlanPreview()) return;
    let disposed = false;
    let refreshing = false;
    const refresh = async (force = false) => {
      if (
        disposed ||
        refreshing ||
        operationRef.current ||
        AppState.currentState === "background" ||
        AppState.currentState === "inactive"
      )
        return;
      refreshing = true;
      try {
        if (revenueCatConfigured && revenueCatAppUserIdRef.current === userId) {
          try {
            const info = await refreshRevenueCatCustomerInfo(force);
            if (!disposed && accountRef.current.userId === userId) updateCustomerInfo(info, userId);
          } catch {
            // Household members can still refresh server-granted access if the store is offline.
          }
        }
        if (!disposed) await refreshVerifiedAccount(userId);
      } catch {
        // Preserve the last verified plan offline and retry on the next tick/foreground.
      } finally {
        refreshing = false;
      }
    };
    backgroundRefreshRef.current = (force) => {
      void refresh(force);
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh(true);
    });
    // Also refresh while the app stays open, including Family members without a store receipt.
    const interval = setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      disposed = true;
      subscription.remove();
      clearInterval(interval);
      backgroundRefreshRef.current = () => undefined;
    };
  }, [hasLoadedAccount, revenueCatConfigured, refreshVerifiedAccount, user?.id]);

  useEffect(() => {
    if (customerInfoAppUserId !== user?.id) return;
    const expiration = getNextRevenueCatExpiration(customerInfo);
    if (expiration === null) return;
    const timer = setTimeout(
      () => backgroundRefreshRef.current(true),
      Math.min(2_147_483_647, Math.max(1000, expiration - Date.now() + 1000))
    );
    return () => clearTimeout(timer);
  }, [customerInfo, customerInfoAppUserId, user?.id]);

  const value = useMemo<BillingContextValue>(() => {
    const expectedRevenueCatAppUserId = user?.id ?? localRevenueCatAppUserId;
    const isCustomerInfoForExpectedIdentity =
      expectedRevenueCatAppUserId != null &&
      revenueCatAppUserId === expectedRevenueCatAppUserId &&
      customerInfoAppUserId === expectedRevenueCatAppUserId;
    const effectiveCustomerInfo = isCustomerInfoForExpectedIdentity ? customerInfo : null;
    const accountBillingTier =
      user?.billingPlan === "plus" || user?.billingPlan === "family" ? user.billingPlan : null;
    const revenueCatTier =
      user?.billingPlan === "free" ? null : getActiveRevenueCatBillingTier(effectiveCustomerInfo);
    const localPlanPreviewEnabled = canUseLocalPlanPreview();
    const previewTier =
      localPlanPreviewEnabled && !revenueCatConfigured && billingState.tier !== "free"
        ? billingState.tier
        : null;
    const activePaidTier = accountBillingTier ?? revenueCatTier ?? previewTier;
    const hasActivePaidPlan = activePaidTier != null;
    const tier: BillingTier = activePaidTier ?? "free";
    const plan = billingPlans[tier];
    const safeRevenueCatAppUserId = expectedRevenueCatAppUserId;
    const effectiveBillingState = {
      ...billingState,
      tier
    };
    const remainingImports = getRemainingImports(effectiveBillingState);
    const remainingStrongExtractions = getRemainingStrongExtractions(effectiveBillingState);
    const canStartImport = () =>
      remainingImports > 0 ? { allowed: true } : getImportLimitMessage(plan);
    const canStartStrongExtraction = () =>
      remainingStrongExtractions > 0 ? { allowed: true } : getStrongExtractionLimitMessage(plan);
    const ensureRevenueCatAccountIdentity = async () => {
      if (!user?.id) {
        return false;
      }

      if (revenueCatAppUserId === user.id && customerInfoAppUserId === user.id) {
        return true;
      }

      const nextCustomerInfo = await loginRevenueCatAccount(user.id);
      updateCustomerInfo(nextCustomerInfo, user.id);
      updateRevenueCatAppUserId(user.id);
      return true;
    };

    return {
      activatePlanPreview: (nextTier) => {
        if (!localPlanPreviewEnabled) {
          return;
        }

        setBillingState((current) => ({
          ...current,
          tier: nextTier
        }));
      },
      activePaidTier,
      canStartImport,
      canStartStrongExtraction,
      customerInfo: effectiveCustomerInfo,
      hasActivePaidPlan,
      hasLoadedBilling,
      offering,
      plan,
      purchaseError,
      restoreMessage,
      purchasePackage: async (selectedPackage) => {
        setPurchaseError(null);
        setRestoreMessage(null);
        if (operationRef.current) return;

        if (!isLaunchProductAvailable(Platform.OS, selectedPackage.product.identifier)) {
          setPurchaseError("This plan is not available for purchase on iOS.");
          return;
        }

        if (!user?.id) {
          setPurchaseError(accountRequiredPurchaseError);
          return;
        }

        operationRef.current = true;
        setPurchaseStatus("purchasing");

        try {
          await ensureRevenueCatAccountIdentity();
          if (accountRef.current.userId !== user.id) return;
          const nextCustomerInfo = await purchaseRevenueCatPackage(selectedPackage);
          if (!mountedRef.current || accountRef.current.userId !== user.id) return;
          updateCustomerInfo(nextCustomerInfo, user.id);
          await syncStoreResult(nextCustomerInfo, user.id, false);

          const periodLabel = getRevenueCatPackagePeriodLabel(selectedPackage);
          trackMobileEvent({
            eventName: "upgrade_purchased",
            routeOrScreen: "upgrade",
            properties: {
              plan: getRevenueCatPackageBillingTier(selectedPackage),
              ...(periodLabel === "Lifetime"
                ? { billing_period: "lifetime", trigger: "founding" }
                : periodLabel === "Yearly"
                  ? { billing_period: "yearly" }
                  : periodLabel === "Monthly"
                    ? { billing_period: "monthly" }
                    : {})
            }
          });
        } catch (error) {
          if (!mountedRef.current || accountRef.current.userId !== user.id) return;
          if (isRevenueCatPurchaseCancelled(error)) {
            return;
          }

          console.warn("Failed to purchase LinkDish paid plan.", error);
          setPurchaseError("Purchase could not be completed. Please try again.");
        } finally {
          operationRef.current = false;
          if (mountedRef.current) setPurchaseStatus("idle");
        }
      },
      purchaseStatus,
      remainingImports,
      remainingStrongExtractions,
      resetToFreePreview: () => {
        if (!localPlanPreviewEnabled) {
          return;
        }

        setBillingState((current) => ({
          ...current,
          tier: "free"
        }));
      },
      restorePurchases: async () => {
        setPurchaseError(null);
        setRestoreMessage(null);
        if (operationRef.current) return;

        if (!user?.id) {
          setRestoreMessage(accountRequiredRestoreError);
          return;
        }

        operationRef.current = true;
        setPurchaseStatus("restoring");

        try {
          await ensureRevenueCatAccountIdentity();
          if (accountRef.current.userId !== user.id) return;
          const nextCustomerInfo = await restoreRevenueCatPurchases();
          if (!mountedRef.current || accountRef.current.userId !== user.id) return;
          updateCustomerInfo(nextCustomerInfo, user.id);
          await syncStoreResult(nextCustomerInfo, user.id, true);
        } catch {
          if (mountedRef.current && accountRef.current.userId === user.id) {
            setRestoreMessage(
              "Purchases could not be restored. Check your connection and try Restore purchases again."
            );
          }
        } finally {
          operationRef.current = false;
          if (mountedRef.current) setPurchaseStatus("idle");
        }
      },
      revenueCatAppUserId: safeRevenueCatAppUserId,
      revenueCatConfigured,
      spendImport: () => {
        const gate = canStartImport();

        if (!gate.allowed) {
          return gate;
        }

        setBillingState((current) => {
          const usage = normalizeBillingUsageForTier(tier, current.usage);

          return {
            ...current,
            usage: {
              ...usage,
              imports: usage.imports + 1
            }
          };
        });

        return gate;
      },
      spendStrongExtraction: () => {
        const gate = canStartStrongExtraction();

        if (!gate.allowed) {
          return gate;
        }

        setBillingState((current) => {
          const usage = normalizeBillingUsageForTier(tier, current.usage);

          return {
            ...current,
            usage: {
              ...usage,
              strongExtractions: usage.strongExtractions + 1
            }
          };
        });

        return gate;
      },
      tier,
      usage: billingState.usage
    };
  }, [
    billingState,
    customerInfo,
    customerInfoAppUserId,
    hasLoadedBilling,
    localRevenueCatAppUserId,
    offering,
    purchaseError,
    restoreMessage,
    syncStoreResult,
    purchaseStatus,
    revenueCatAppUserId,
    revenueCatConfigured,
    user?.billingPlan,
    user?.id
  ]);

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
};

export const useBilling = () => {
  const context = useContext(BillingContext);

  if (!context) {
    throw new Error("useBilling must be used within BillingProvider.");
  }

  return context;
};
