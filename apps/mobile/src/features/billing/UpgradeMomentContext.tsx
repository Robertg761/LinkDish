import { AppButton, AppChip, AppSurface, AppText } from "@linkdish/ui";
import { router } from "expo-router";
import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { appColors, appSpacing } from "../../theme/tokens";
import { useAccount } from "../account/AccountContext";

import { useBilling } from "./BillingContext";
import { billingPlans, paidBillingTiers, type PaidBillingTier } from "./plans";
import { paidPlanFeatures } from "./plans-content";
import {
  createUpgradeMomentSessionGate,
  type UpgradeMomentTrigger
} from "./upgrade-moment-session";

export type { UpgradeMomentTrigger } from "./upgrade-moment-session";

interface UpgradeMomentContextValue {
  showUpgradeMoment: (trigger: UpgradeMomentTrigger) => void;
}

const triggerCopy: Record<UpgradeMomentTrigger, { body: string; eyebrow: string; title: string }> =
  {
    fourth_import_monthly: {
      body: "You have one free import left this month. Plus and Family keep the recipe pipeline open when the week gets busy.",
      eyebrow: "One left this month",
      title: "Keep saving the recipes worth cooking"
    },
    save_limit: {
      body: `Free saves up to ${billingPlans.free.limits.savedRecipes} personal recipes. Upgrade when your Cookbook is full.`,
      eyebrow: "Cookbook full",
      title: "Save unlimited recipes"
    },
    share_sheet_quota_exceeded: {
      body: "That shared recipe is waiting, but this month's free imports are used. Upgrade to keep importing from the share sheet.",
      eyebrow: "Monthly imports used",
      title: "Bring this one into LinkDish"
    },
    share_to_family_no_plan: {
      body: "Family sharing lives on LinkDish Family: one household, one shared monthly import allowance, and a recipe book everyone can use.",
      eyebrow: "Family sharing",
      title: "Share the kitchen with your household"
    }
  };

const UpgradeMomentContext = createContext<UpgradeMomentContextValue | null>(null);
const noopUpgradeMomentContext: UpgradeMomentContextValue = {
  showUpgradeMoment: () => undefined
};

export const UpgradeMomentProvider = ({ children }: PropsWithChildren) => {
  const [activeTrigger, setActiveTrigger] = useState<UpgradeMomentTrigger | null>(null);
  const gateRef = useRef(createUpgradeMomentSessionGate());

  const value = useMemo<UpgradeMomentContextValue>(
    () => ({
      showUpgradeMoment: (trigger) => {
        if (!gateRef.current.shouldOpen(trigger, activeTrigger)) {
          return;
        }

        trackMobileEvent({
          eventName: "upgrade_viewed",
          routeOrScreen: "upgrade-sheet",
          properties: {
            trigger
          }
        });
        setActiveTrigger(trigger);
      }
    }),
    [activeTrigger]
  );

  return (
    <UpgradeMomentContext.Provider value={value}>
      {children}
      <UpgradeMomentSheet activeTrigger={activeTrigger} onClose={() => setActiveTrigger(null)} />
    </UpgradeMomentContext.Provider>
  );
};

export const useUpgradeMoment = () => {
  const context = useContext(UpgradeMomentContext);

  if (!context) {
    throw new Error("useUpgradeMoment must be used within UpgradeMomentProvider.");
  }

  return context;
};

export const useOptionalUpgradeMoment = (): UpgradeMomentContextValue => {
  const context = useContext(UpgradeMomentContext);

  return context ?? noopUpgradeMomentContext;
};

const UpgradeMomentSheet = ({
  activeTrigger,
  onClose
}: {
  activeTrigger: UpgradeMomentTrigger | null;
  onClose: () => void;
}) => {
  const { hasLoadedAccount, user } = useAccount();
  const { tier } = useBilling();
  const { width } = useWindowDimensions();

  if (!activeTrigger) {
    return null;
  }

  const copy = triggerCopy[activeTrigger];

  const openPlans = () => {
    onClose();
    router.push("/upgrade" as never);
  };

  const openAccount = () => {
    onClose();
    router.push("/account" as never);
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <View style={styles.overlay}>
        <Pressable
          accessibilityLabel="Dismiss upgrade prompt"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <AppSurface style={[styles.sheet, { width: Math.min(width - 28, 520) }]}>
          <View style={styles.header}>
            <AppChip label={copy.eyebrow} tone="accent" />
            <AppText style={styles.title} variant="headline">
              {copy.title}
            </AppText>
            <AppText muted style={styles.body}>
              {copy.body}
            </AppText>
          </View>

          <ScrollView
            contentContainerStyle={styles.planList}
            showsVerticalScrollIndicator={false}
            style={styles.planScroller}
          >
            {paidBillingTiers.map((planId) => (
              <SheetPlanCard
                isActive={tier === planId}
                key={planId}
                planId={planId}
              />
            ))}
          </ScrollView>

          <View style={styles.actions}>
            {hasLoadedAccount && !user ? (
              <AppButton label="Sign in to upgrade" onPress={openAccount} />
            ) : (
              <AppButton label="View plans" onPress={openPlans} />
            )}
            <AppButton label="Not now" onPress={onClose} variant="ghost" />
          </View>
        </AppSurface>
      </View>
    </Modal>
  );
};

const SheetPlanCard = ({
  isActive,
  planId
}: {
  isActive: boolean;
  planId: PaidBillingTier;
}) => {
  const plan = billingPlans[planId];

  return (
    <View style={styles.planCard}>
      <View style={styles.planHeader}>
        <View style={styles.planName}>
          <AppText variant="title">{plan.displayName}</AppText>
          <AppText muted>
            {plan.monthlyPrice}/month or {plan.yearlyPrice}/year
          </AppText>
        </View>
        <AppChip label={planId === "family" ? "Family" : "Recommended"} tone="accent" />
      </View>

      <View style={styles.featureList}>
        {paidPlanFeatures[planId].map((feature) => (
          <View key={feature} style={styles.featureRow}>
            <View style={styles.bullet} />
            <AppText style={styles.featureText}>{feature}</AppText>
          </View>
        ))}
      </View>

      {isActive ? <AppText tone="accent">Active plan</AppText> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  actions: {
    gap: appSpacing.sm
  },
  backdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: appColors.backdrop
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  bullet: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 6,
    marginTop: 8,
    width: 6
  },
  featureList: {
    gap: appSpacing.sm
  },
  featureRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: appSpacing.sm
  },
  featureText: {
    flex: 1,
    lineHeight: 21
  },
  header: {
    alignItems: "center",
    gap: appSpacing.sm
  },
  overlay: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: appSpacing.lg
  },
  planCard: {
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    gap: appSpacing.md,
    padding: appSpacing.lg
  },
  planHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: appSpacing.md,
    justifyContent: "space-between"
  },
  planList: {
    gap: appSpacing.md
  },
  planName: {
    flex: 1,
    gap: appSpacing.xs
  },
  planScroller: {
    maxHeight: 300
  },
  sheet: {
    gap: appSpacing.lg,
    maxHeight: "86%",
    padding: appSpacing.xl
  },
  title: {
    textAlign: "center"
  }
});
