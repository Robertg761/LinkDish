import { billingPlans, type BillingTier } from "./plans";

export interface BillingState {
  tier: BillingTier;
  usage: BillingUsagePeriod;
  usageAccountingVersion: number;
}

export interface BillingUsagePeriod {
  imports: number;
  periodKey: string;
  strongExtractions: number;
}

const defaultTier: BillingTier = "free";
const currentUsageAccountingVersion = 3;

export const getBillingPeriodKey = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

export const createBillingUsagePeriod = (
  periodKey = getBillingPeriodKey()
): BillingUsagePeriod => ({
  imports: 0,
  periodKey,
  strongExtractions: 0
});

export const normalizeBillingState = (
  value: unknown,
  periodKey = getBillingPeriodKey()
): BillingState => {
  if (!value || typeof value !== "object") {
    return {
      tier: defaultTier,
      usage: createBillingUsagePeriod(periodKey),
      usageAccountingVersion: currentUsageAccountingVersion
    };
  }

  const candidate = value as {
    tier?: unknown;
    usageAccountingVersion?: unknown;
    usage?: {
      imports?: unknown;
      periodKey?: unknown;
      strongExtractions?: unknown;
    };
  };
  const tier =
    candidate.tier === "plus" || candidate.tier === "family" || candidate.tier === "free"
      ? candidate.tier
      : defaultTier;
  const storedUsage = candidate.usage;
  const parsedStoredUsage =
    candidate.usageAccountingVersion === currentUsageAccountingVersion &&
    storedUsage &&
    typeof storedUsage.periodKey === "string" &&
    typeof storedUsage.imports === "number" &&
    typeof storedUsage.strongExtractions === "number"
      ? {
          imports: storedUsage.imports,
          periodKey: storedUsage.periodKey,
          strongExtractions: storedUsage.strongExtractions
        }
      : null;
  const shouldPreserveStoredUsage =
    parsedStoredUsage != null && (tier === "free" || parsedStoredUsage.periodKey === periodKey);
  const usage =
    parsedStoredUsage && shouldPreserveStoredUsage
      ? {
          imports: Math.max(0, Math.floor(parsedStoredUsage.imports)),
          periodKey: tier === "free" ? parsedStoredUsage.periodKey : periodKey,
          strongExtractions: Math.max(0, Math.floor(parsedStoredUsage.strongExtractions))
        }
      : createBillingUsagePeriod(periodKey);

  return {
    tier,
    usage,
    usageAccountingVersion: currentUsageAccountingVersion
  };
};

export const normalizeBillingUsageForTier = (
  tier: BillingTier,
  usage: BillingUsagePeriod,
  periodKey = getBillingPeriodKey()
): BillingUsagePeriod => {
  if (tier === "free" || usage.periodKey === periodKey) {
    return usage;
  }

  return createBillingUsagePeriod(periodKey);
};

export const parseBillingState = (
  serializedState: string | null,
  periodKey = getBillingPeriodKey()
): BillingState => {
  if (!serializedState) {
    return normalizeBillingState(null, periodKey);
  }

  try {
    return normalizeBillingState(JSON.parse(serializedState) as unknown, periodKey);
  } catch {
    return normalizeBillingState(null, periodKey);
  }
};

export const serializeBillingState = (state: BillingState): string => JSON.stringify(state);

export const getRemainingImports = (state: BillingState): number =>
  Math.max(
    0,
    billingPlans[state.tier].limits.monthlyImports -
      normalizeBillingUsageForTier(state.tier, state.usage).imports
  );

export const getRemainingStrongExtractions = (state: BillingState): number =>
  Math.max(
    0,
    billingPlans[state.tier].limits.monthlyStrongExtractions -
      normalizeBillingUsageForTier(state.tier, state.usage).strongExtractions
  );

export const canSaveAnotherRecipe = (
  tier: BillingTier,
  savedRecipeCount: number,
  isAlreadySaved: boolean
): boolean => {
  if (isAlreadySaved) {
    return true;
  }

  const limit = billingPlans[tier].limits.savedRecipes;
  return limit == null || savedRecipeCount < limit;
};
