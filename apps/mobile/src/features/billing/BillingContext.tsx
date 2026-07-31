import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";

import { trackMobileEvent } from "../../analytics/client";
import { mobileEnv } from "../../config/env";
import { useAccount } from "../account/AccountContext";

import { billingPlans, type BillingPlan, type BillingTier, type PaidBillingTier } from "./plans";
import {
  addRevenueCatCustomerInfoListener,
  configureRevenueCat,
  getActiveRevenueCatBillingTier,
  getRevenueCatOffering,
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
      ? "You have used your free recipe imports. LinkDish Plus includes 100 imports each month, and Family includes 250."
      : `You have used this month's ${plan.displayName} recipe imports.`
});

const getStrongExtractionLimitMessage = (plan: BillingPlan): BillingGateResult => ({
  allowed: false,
  title: plan.id === "free" ? "Free recipe imports used" : "Monthly recipe imports used",
  message:
    plan.id === "free"
      ? "You have used your free recipe imports. LinkDish Plus includes 100 imports each month, and Family includes 250."
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
  const { hasLoadedAccount, user } = useAccount();
  const [hasLoadedBilling, setHasLoadedBilling] = useState(false);
  const [billingState, setBillingState] = useState<BillingState>(() => parseBillingState(null));
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [offering, setOffering] = useState<PurchasesOffering | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<PurchaseStatus>("loading");
  const [localRevenueCatAppUserId, setLocalRevenueCatAppUserId] = useState<string | null>(null);
  const [revenueCatAppUserId, setRevenueCatAppUserId] = useState<string | null>(null);
  const revenueCatAppUserIdRef = useRef<string | null>(null);
  const [revenueCatConfigured, setRevenueCatConfigured] = useState(false);
  const [customerInfoAppUserId, setCustomerInfoAppUserId] = useState<string | null>(null);

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
  }, [hasLoadedAccount]);

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
      purchasePackage: async (selectedPackage) => {
        setPurchaseError(null);

        if (!user?.id) {
          setPurchaseError(accountRequiredPurchaseError);
          return;
        }

        setPurchaseStatus("purchasing");

        try {
          await ensureRevenueCatAccountIdentity();
          const nextCustomerInfo = await purchaseRevenueCatPackage(selectedPackage);
          updateCustomerInfo(nextCustomerInfo, user.id);
          setPurchaseStatus("idle");

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
          setPurchaseStatus("idle");

          if (isRevenueCatPurchaseCancelled(error)) {
            return;
          }

          console.warn("Failed to purchase LinkDish paid plan.", error);
          setPurchaseError("Purchase could not be completed. Please try again.");
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

        if (!user?.id) {
          setPurchaseError(accountRequiredRestoreError);
          return;
        }

        setPurchaseStatus("restoring");

        try {
          await ensureRevenueCatAccountIdentity();
          const nextCustomerInfo = await restoreRevenueCatPurchases();
          updateCustomerInfo(nextCustomerInfo, user.id);
          setPurchaseStatus("idle");

          if (!hasActiveRevenueCatPaidPlan(nextCustomerInfo)) {
            setPurchaseError("No active LinkDish purchase was found for this store account.");
          }
        } catch (error) {
          setPurchaseStatus("idle");
          console.warn("Failed to restore LinkDish purchases.", error);
          setPurchaseError("Purchases could not be restored. Please try again.");
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
