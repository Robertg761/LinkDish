import { AppButton, AppChip, AppSurface, AppText } from "@linkdish/ui";
import { router } from "expo-router";
import { useEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { trackMobileEvent } from "../src/analytics/client";
import { mobileEnv } from "../src/config/env";
import { useAccount } from "../src/features/account/AccountContext";
import { useBilling } from "../src/features/billing/BillingContext";
import {
  billingPlans,
  paidBillingTiers,
  type PaidBillingTier
} from "../src/features/billing/plans";
import {
  freePlanFeatures,
  paidPlanFeatures,
  pricingNotes
} from "../src/features/billing/plans-content";
import {
  getRevenueCatPackageBillingTier,
  getRevenueCatPackagePeriodLabel,
  isFoundingLifetimePackage,
  type PurchasesPackage
} from "../src/features/billing/revenuecat";
import { appColors } from "../src/theme/tokens";

const buildPurchaseOptionsByTier = (
  options: PurchasesPackage[]
): Record<PaidBillingTier, PurchasesPackage[]> => {
  const groups: Record<PaidBillingTier, PurchasesPackage[]> = {
    plus: [],
    family: []
  };

  for (const option of options) {
    groups[getRevenueCatPackageBillingTier(option)].push(option);
  }

  return groups;
};

const getPurchaseOptionRank = (option: PurchasesPackage): number => {
  const label = getRevenueCatPackagePeriodLabel(option);

  if (label === "Yearly") {
    return 0;
  }

  if (label === "Monthly") {
    return 1;
  }

  return 2;
};

const getPlanPriceSummary = ({
  hasLoadedBilling,
  plan,
  purchaseOptions,
  revenueCatConfigured
}: {
  hasLoadedBilling: boolean;
  plan: (typeof billingPlans)[PaidBillingTier];
  purchaseOptions: PurchasesPackage[];
  revenueCatConfigured: boolean;
}): string => {
  if (!revenueCatConfigured) {
    return `${plan.monthlyPrice}/month or ${plan.yearlyPrice}/year`;
  }

  const monthlyOption = purchaseOptions.find(
    (option) => getRevenueCatPackagePeriodLabel(option) === "Monthly"
  );
  const yearlyOption = purchaseOptions.find(
    (option) => getRevenueCatPackagePeriodLabel(option) === "Yearly"
  );

  if (monthlyOption && yearlyOption) {
    return `${monthlyOption.product.priceString}/month or ${yearlyOption.product.priceString}/year`;
  }

  if (monthlyOption) {
    return `${monthlyOption.product.priceString}/month`;
  }

  if (yearlyOption) {
    return `${yearlyOption.product.priceString}/year`;
  }

  return hasLoadedBilling ? "Price unavailable in your region" : "Loading local prices...";
};

export default function UpgradeScreen() {
  const { hasLoadedAccount, user } = useAccount();
  const {
    activatePlanPreview,
    hasLoadedBilling,
    offering,
    plan,
    purchaseError,
    purchasePackage,
    purchaseStatus,
    remainingImports,
    resetToFreePreview,
    restorePurchases,
    revenueCatConfigured,
    tier
  } = useBilling();
  const availablePackages = offering?.availablePackages ?? [];
  const foundingPackage = availablePackages.find(isFoundingLifetimePackage);
  const purchaseOptionsByTier = buildPurchaseOptionsByTier(
    availablePackages.filter((option) => !isFoundingLifetimePackage(option))
  );
  const hasFamilyPlan = tier === "family";
  const isPurchaseBusy =
    purchaseStatus === "loading" ||
    purchaseStatus === "purchasing" ||
    purchaseStatus === "restoring";
  const canUseLocalPlanPreview =
    process.env.NODE_ENV !== "production" && mobileEnv.localPlanPreviewEnabled;
  const hasServerAccount = Boolean(user?.id);

  useEffect(() => {
    trackMobileEvent({
      eventName: "upgrade_viewed",
      routeOrScreen: "upgrade",
      properties: {
        trigger: "pricing"
      }
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <AppChip label={tier === "free" ? "Plans" : "Active"} tone="accent" />
        <AppText style={styles.title} variant="display">
          LinkDish Plans
        </AppText>
        <AppText muted>
          Paid plans cover the ongoing recipe import service: fetching links, cleaning recipes into
          a cooking view, and giving difficult pages another chance when details are missing.
        </AppText>
      </View>

      <View style={styles.freeOverview}>
        <PlanSummaryCard eyebrow="Start free" features={freePlanFeatures} title="Free start" />
      </View>

      {paidBillingTiers.map((planId) => (
        <PaidPlanCard
          activatePlanPreview={activatePlanPreview}
          canUseLocalPlanPreview={canUseLocalPlanPreview}
          hasLoadedBilling={hasLoadedBilling}
          hasAccount={Boolean(user?.id)}
          isActive={tier === planId}
          isAccountLoading={!hasLoadedAccount}
          isIncluded={tier === "family" && planId === "plus"}
          isPurchaseBusy={isPurchaseBusy}
          key={planId}
          planId={planId}
          purchaseError={purchaseError}
          purchaseOptions={purchaseOptionsByTier[planId]}
          purchasePackage={purchasePackage}
          revenueCatConfigured={revenueCatConfigured}
        />
      ))}

      {foundingPackage && tier === "free" ? (
        <FoundingPlanCard
          foundingPackage={foundingPackage}
          hasAccount={hasServerAccount}
          isAccountLoading={!hasLoadedAccount}
          isPurchaseBusy={isPurchaseBusy}
          purchaseError={purchaseError}
          purchasePackage={purchasePackage}
        />
      ) : null}

      <AppSurface style={styles.promiseCard} tone="subtle">
        <AppText variant="title">Your recipes stay yours</AppText>
        <AppText muted>
          Free keeps up to {billingPlans.free.limits.savedRecipes} personal recipes. Paid plans add
          more imports, unlimited saves, and better recovery for difficult links.
        </AppText>
      </AppSurface>

      {hasFamilyPlan ? (
        <AppSurface style={styles.householdCard}>
          <AppText variant="title">Family Household</AppText>
          <AppText muted>
            {user
              ? "Manage the household connected to your LinkDish account."
              : "Sign in to create or manage household sharing for your Family plan."}
          </AppText>
          <AppButton
            label={user ? "Manage Household" : "Sign in to manage household"}
            onPress={() => router.push((user ? "/household" : "/account") as never)}
          />
        </AppSurface>
      ) : null}

      <AppSurface style={styles.notesCard}>
        <AppText variant="title">How Pricing Works</AppText>
        <View style={styles.noteList}>
          {pricingNotes.map((note) => (
            <View key={note.title} style={styles.noteRow}>
              <AppText style={styles.noteTitle}>{note.title}</AppText>
              <AppText muted style={styles.noteBody}>
                {note.body}
              </AppText>
            </View>
          ))}
        </View>
      </AppSurface>

      <AppSurface style={styles.usageCard} tone="subtle">
        <AppText variant="title">Usage</AppText>
        <View style={styles.usageRows}>
          <UsageRow label="Plan" value={plan.displayName} />
          {tier === "free" ? (
            <UsageRow
              label={hasServerAccount ? "Free recipe imports" : "Free imports left"}
              value={
                hasServerAccount
                  ? `${plan.limits.monthlyImports} total allowance`
                  : `${remainingImports} of ${plan.limits.monthlyImports} total`
              }
            />
          ) : (
            <UsageRow label="Recipe imports" value={`${plan.limits.monthlyImports} per month`} />
          )}
        </View>
        {hasServerAccount ? (
          <AppText muted style={styles.usageNote}>
            Your current balance is checked by LinkDish when you import a recipe.
          </AppText>
        ) : null}
      </AppSurface>

      <View style={styles.footerActions}>
        <AppButton label="Back to recipes" onPress={() => router.back()} variant="secondary" />
        {revenueCatConfigured ? (
          user ? (
            <AppButton
              disabled={isPurchaseBusy}
              label={purchaseStatus === "restoring" ? "Restoring purchases" : "Restore purchases"}
              onPress={restorePurchases}
              variant="ghost"
            />
          ) : (
            <AppButton
              label="Sign in to restore purchases"
              onPress={() => router.push("/account" as never)}
              variant="ghost"
            />
          )
        ) : tier !== "free" && canUseLocalPlanPreview ? (
          <AppButton label="Reset preview to Free" onPress={resetToFreePreview} variant="ghost" />
        ) : null}
      </View>
    </ScrollView>
  );
}

const UsageRow = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.usageRow}>
    <AppText muted>{label}</AppText>
    <AppText style={styles.usageValue}>{value}</AppText>
  </View>
);

const PaidPlanCard = ({
  activatePlanPreview,
  canUseLocalPlanPreview,
  hasAccount,
  hasLoadedBilling,
  isAccountLoading,
  isActive,
  isIncluded,
  isPurchaseBusy,
  planId,
  purchaseError,
  purchaseOptions,
  purchasePackage,
  revenueCatConfigured
}: {
  activatePlanPreview: (tier: PaidBillingTier) => void;
  canUseLocalPlanPreview: boolean;
  hasAccount: boolean;
  hasLoadedBilling: boolean;
  isAccountLoading: boolean;
  isActive: boolean;
  isIncluded: boolean;
  isPurchaseBusy: boolean;
  planId: PaidBillingTier;
  purchaseError: string | null;
  purchaseOptions: PurchasesPackage[];
  purchasePackage: (selectedPackage: PurchasesPackage) => Promise<void>;
  revenueCatConfigured: boolean;
}) => {
  const plan = billingPlans[planId];
  const sortedOptions = [...purchaseOptions].sort(
    (left, right) => getPurchaseOptionRank(left) - getPurchaseOptionRank(right)
  );
  const priceSummary = getPlanPriceSummary({
    hasLoadedBilling,
    plan,
    purchaseOptions: sortedOptions,
    revenueCatConfigured
  });

  return (
    <AppSurface style={styles.planCard}>
      <View style={styles.planHeader}>
        <View style={styles.planName}>
          <AppText variant="title">{plan.displayName}</AppText>
          <AppText muted>{priceSummary}</AppText>
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

      {isActive ? (
        <AppButton disabled label={`${plan.displayName} active`} onPress={() => undefined} />
      ) : isIncluded ? (
        <AppButton disabled label="Included in Family" onPress={() => undefined} />
      ) : revenueCatConfigured && !hasAccount ? (
        <View style={styles.purchaseOptions}>
          <AppText muted>
            Sign in before choosing a paid plan so LinkDish can connect your store purchase to your
            recipe import quota and restores.
          </AppText>
          <AppButton
            disabled={isAccountLoading}
            label={isAccountLoading ? "Checking account" : "Sign in to upgrade"}
            onPress={() => router.push("/account" as never)}
            variant="secondary"
          />
        </View>
      ) : revenueCatConfigured && sortedOptions.length > 0 ? (
        <View style={styles.purchaseOptions}>
          {sortedOptions.map((option) => {
            const periodLabel = getRevenueCatPackagePeriodLabel(option);

            return (
              <AppButton
                disabled={isPurchaseBusy}
                key={option.identifier}
                label={`${periodLabel} - ${option.product.priceString}`}
                onPress={() => purchasePackage(option)}
                variant={periodLabel === "Yearly" ? "primary" : "secondary"}
              />
            );
          })}
        </View>
      ) : revenueCatConfigured ? (
        <AppText muted>
          {hasLoadedBilling
            ? `${plan.displayName} is not available for purchase right now. Please try again later.`
            : "Loading purchase options..."}
        </AppText>
      ) : canUseLocalPlanPreview ? (
        <AppButton
          label={`Activate ${plan.displayName} preview`}
          onPress={() => activatePlanPreview(planId)}
        />
      ) : (
        <AppText muted>Purchases are unavailable right now. Please try again later.</AppText>
      )}

      {purchaseError ? (
        <AppText muted style={styles.errorText}>
          {purchaseError}
        </AppText>
      ) : null}
    </AppSurface>
  );
};

const FoundingPlanCard = ({
  foundingPackage,
  hasAccount,
  isAccountLoading,
  isPurchaseBusy,
  purchaseError,
  purchasePackage
}: {
  foundingPackage: PurchasesPackage;
  hasAccount: boolean;
  isAccountLoading: boolean;
  isPurchaseBusy: boolean;
  purchaseError: string | null;
  purchasePackage: (selectedPackage: PurchasesPackage) => Promise<void>;
}) => (
  <AppSurface style={styles.planCard}>
    <View style={styles.planHeader}>
      <View style={styles.planName}>
        <AppText variant="title">Founding Plus</AppText>
        <AppText muted>Everything in Plus, forever. One payment, no subscription.</AppText>
      </View>
      <AppChip label="Founding member" tone="accent" />
    </View>

    <View style={styles.featureList}>
      {paidPlanFeatures.plus.map((feature) => (
        <View key={feature} style={styles.featureRow}>
          <View style={styles.bullet} />
          <AppText style={styles.featureText}>{feature}</AppText>
        </View>
      ))}
    </View>

    {hasAccount ? (
      <AppButton
        disabled={isPurchaseBusy}
        label={`Become a founding member - ${foundingPackage.product.priceString}`}
        onPress={() => purchasePackage(foundingPackage)}
      />
    ) : (
      <View style={styles.purchaseOptions}>
        <AppText muted>
          Sign in before claiming Founding Plus so LinkDish can connect your purchase to your recipe
          import quota and restores.
        </AppText>
        <AppButton
          disabled={isAccountLoading}
          label={isAccountLoading ? "Checking account" : "Sign in to claim"}
          onPress={() => router.push("/account" as never)}
          variant="secondary"
        />
      </View>
    )}

    {purchaseError ? (
      <AppText muted style={styles.errorText}>
        {purchaseError}
      </AppText>
    ) : null}
  </AppSurface>
);

const PlanSummaryCard = ({
  eyebrow,
  features,
  title
}: {
  eyebrow: string;
  features: string[];
  title: string;
}) => (
  <AppSurface style={styles.summaryCard}>
    <AppChip label={eyebrow} tone="default" />
    <AppText variant="title">{title}</AppText>
    <View style={styles.featureList}>
      {features.map((feature) => (
        <View key={feature} style={styles.featureRow}>
          <View style={styles.bullet} />
          <AppText style={styles.featureText}>{feature}</AppText>
        </View>
      ))}
    </View>
  </AppSurface>
);

const styles = StyleSheet.create({
  bullet: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 7,
    marginTop: 8,
    width: 7
  },
  container: {
    backgroundColor: appColors.background,
    gap: 18,
    padding: 20
  },
  featureList: {
    gap: 12
  },
  featureRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10
  },
  featureText: {
    flex: 1
  },
  errorText: {
    color: appColors.danger
  },
  footerActions: {
    gap: 10
  },
  header: {
    gap: 12,
    paddingTop: 8
  },
  householdCard: {
    gap: 12
  },
  noteBody: {
    flex: 1
  },
  noteList: {
    gap: 14
  },
  noteRow: {
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    gap: 4,
    paddingBottom: 12
  },
  noteTitle: {
    fontWeight: "700"
  },
  notesCard: {
    gap: 16
  },
  planCard: {
    gap: 18
  },
  freeOverview: {
    gap: 12
  },
  planHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 14,
    justifyContent: "space-between"
  },
  planName: {
    flex: 1,
    gap: 4
  },
  purchaseOptions: {
    gap: 10
  },
  promiseCard: {
    gap: 8
  },
  summaryCard: {
    gap: 14,
    shadowOpacity: 0.04
  },
  title: {
    lineHeight: 52,
    paddingBottom: 4
  },
  usageCard: {
    gap: 16
  },
  usageRow: {
    alignItems: "center",
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingBottom: 10
  },
  usageRows: {
    gap: 10
  },
  usageNote: {
    lineHeight: 20
  },
  usageValue: {
    fontWeight: "700"
  }
});
