import { billingPlans, formatLimit, type PaidBillingTier } from "./plans";

export const paidPlanFeatures: Record<PaidBillingTier, string[]> = {
  plus: [
    `${billingPlans.plus.limits.monthlyImports} recipe imports each month`,
    formatLimit(billingPlans.plus.limits.savedRecipes, "saved recipes")
  ],
  family: [
    `${billingPlans.family.limits.monthlyImports} recipe imports each month`,
    formatLimit(billingPlans.family.limits.savedRecipes, "saved recipes"),
    "Made for household sharing"
  ]
};

export const freePlanFeatures = [
  `${billingPlans.free.limits.monthlyImports} recipe imports total to try LinkDish`,
  `Save up to ${billingPlans.free.limits.savedRecipes} recipes free`,
  "Upgrade for unlimited saves"
];

export const pricingNotes = [
  {
    body: "Recipe imports run through LinkDish servers to fetch pages, clean up messy recipe data, and return structured recipes. Some difficult links need extra processing to recover missing details.",
    title: "Why paid plans exist"
  },
  {
    body: "Nothing you saved disappears. You can keep reading saved recipes and upgrade again when you want more imports or unlimited saves.",
    title: "If you cancel"
  },
  {
    body: "LinkDish Family is meant for one household that wants more recipe imports and unlimited saves. Sign in to create a household, invite members, and share one Family allowance.",
    title: "Family plan"
  }
];
