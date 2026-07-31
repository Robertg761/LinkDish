import type { AccountUser } from "@linkdish/api-contracts";

export type WebBillingTier = "free" | "plus" | "family";

export interface WebBillingPlan {
  displayName: string;
  limits: {
    monthlyImports: number;
    monthlyStrongExtractions: number;
    savedRecipes: number | "unlimited";
  };
}

export interface BillingGateResult {
  allowed: boolean;
  message?: string;
  title?: string;
}

const BILLING_USAGE_STORAGE_KEY = "linkdish:web:billing-usage:v2";

export const webBillingPlans: Record<WebBillingTier, WebBillingPlan> = {
  free: {
    displayName: "Free",
    limits: {
      monthlyImports: 3,
      monthlyStrongExtractions: 3,
      savedRecipes: 15
    }
  },
  plus: {
    displayName: "Plus",
    limits: {
      monthlyImports: 100,
      monthlyStrongExtractions: 100,
      savedRecipes: "unlimited"
    }
  },
  family: {
    displayName: "Family",
    limits: {
      monthlyImports: 250,
      monthlyStrongExtractions: 250,
      savedRecipes: "unlimited"
    }
  }
};

interface WebBillingUsage {
  monthKey: string;
  imports: number;
  strongExtractions: number;
}

const getMonthKey = (date = new Date()) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const emptyUsage = (): WebBillingUsage => ({
  imports: 0,
  monthKey: getMonthKey(),
  strongExtractions: 0
});

const normalizeUsageForTier = (tier: WebBillingTier, usage: WebBillingUsage): WebBillingUsage =>
  tier === "free" || usage.monthKey === getMonthKey() ? usage : emptyUsage();

export const getWebBillingTier = (user: AccountUser | null | undefined): WebBillingTier =>
  user?.billingPlan === "plus" || user?.billingPlan === "family" ? user.billingPlan : "free";

export const readWebBillingUsage = (): WebBillingUsage => {
  try {
    const rawUsage = localStorage.getItem(BILLING_USAGE_STORAGE_KEY);
    if (!rawUsage) {
      return emptyUsage();
    }

    const parsedUsage = JSON.parse(rawUsage) as Partial<WebBillingUsage>;
    return {
      imports: Number.isFinite(parsedUsage.imports) ? Number(parsedUsage.imports) : 0,
      monthKey: typeof parsedUsage.monthKey === "string" ? parsedUsage.monthKey : getMonthKey(),
      strongExtractions: Number.isFinite(parsedUsage.strongExtractions)
        ? Number(parsedUsage.strongExtractions)
        : 0
    };
  } catch {
    return emptyUsage();
  }
};

const writeWebBillingUsage = (usage: WebBillingUsage) => {
  localStorage.setItem(BILLING_USAGE_STORAGE_KEY, JSON.stringify(usage));
};

const getLimitMessage = (plan: WebBillingPlan): BillingGateResult => ({
  allowed: false,
  message:
    plan.displayName === "Free"
      ? "You have used your free recipe imports. LinkDish Plus includes 100 imports each month, and Family includes 250."
      : `You have used this month's ${plan.displayName} recipe imports.`,
  title: plan.displayName === "Free" ? "Free recipe imports used" : "Monthly recipe imports used"
});

export const getRemainingImports = (tier: WebBillingTier, usage = readWebBillingUsage()) =>
  Math.max(
    webBillingPlans[tier].limits.monthlyImports - normalizeUsageForTier(tier, usage).imports,
    0
  );

export const getRemainingStrongExtractions = (
  tier: WebBillingTier,
  usage = readWebBillingUsage()
) =>
  Math.max(
    webBillingPlans[tier].limits.monthlyStrongExtractions -
      normalizeUsageForTier(tier, usage).strongExtractions,
    0
  );

export const canStartWebImport = (tier: WebBillingTier): BillingGateResult =>
  getRemainingImports(tier) > 0 ? { allowed: true } : getLimitMessage(webBillingPlans[tier]);

export const canStartWebStrongExtraction = (tier: WebBillingTier): BillingGateResult =>
  getRemainingStrongExtractions(tier) > 0
    ? { allowed: true }
    : getLimitMessage(webBillingPlans[tier]);

export const spendWebImport = (tier: WebBillingTier) => {
  const gate = canStartWebImport(tier);

  if (!gate.allowed) {
    return gate;
  }

  const usage = readWebBillingUsage();
  const normalizedUsage = normalizeUsageForTier(tier, usage);
  writeWebBillingUsage({
    ...normalizedUsage,
    imports: normalizedUsage.imports + 1
  });

  return gate;
};

export const spendWebStrongExtraction = (tier: WebBillingTier) => {
  const gate = canStartWebStrongExtraction(tier);

  if (!gate.allowed) {
    return gate;
  }

  const usage = readWebBillingUsage();
  const normalizedUsage = normalizeUsageForTier(tier, usage);
  writeWebBillingUsage({
    ...normalizedUsage,
    strongExtractions: normalizedUsage.strongExtractions + 1
  });

  return gate;
};
