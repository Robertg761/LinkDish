import { describe, expect, it } from "vitest";

import { webBillingPlans } from "../billing/web-billing";

import {
  defaultBillingAvailability,
  getBestYearlySavings,
  getPlanPriceDisplay,
  getPurchasablePeriod,
  planComparisonRows,
  planContent
} from "./plans-content";

import type { WebBillingAvailability } from "@linkdish/api-contracts";

const availableEverywhere: WebBillingAvailability = {
  ...defaultBillingAvailability,
  plans: {
    family: { monthly: true, yearly: true },
    plus: { monthly: true, yearly: true }
  },
  webCheckoutEnabled: true
};

describe("plan content", () => {
  it("keeps plan limits in the copy aligned with the billing limits", () => {
    const text = (tier: keyof typeof planContent) =>
      planContent[tier].highlights.map((item) => `${item.emphasis ?? ""}${item.text}`).join(" ");

    expect(text("free")).toContain(`${webBillingPlans.free.limits.monthlyImports} recipe imports`);
    expect(text("free")).toContain(`Up to ${webBillingPlans.free.limits.savedRecipes} saved`);
    expect(text("plus")).toContain(`${webBillingPlans.plus.limits.monthlyImports} recipe imports`);
    expect(text("plus")).toContain("Unlimited saved recipes");
    expect(text("family")).toContain(`${webBillingPlans.family.limits.monthlyImports} imports`);
    expect(text("family")).toContain("Up to 6 people");
  });

  it("never sells features every plan has as paid-only", () => {
    const everyPlan = ["Cook mode with timers", "Shopping list", "Works offline", "No ads"];

    for (const label of everyPlan) {
      const row = planComparisonRows.find((candidate) => candidate.label === label);
      expect(row?.values).toEqual({ family: true, free: true, plus: true });
    }

    const familyOnly = planComparisonRows
      .filter((row) => row.values.family === true)
      .filter((row) => row.values.plus === false)
      .map((row) => row.label);
    expect(familyOnly).toEqual(["Family sharing", "Household shopping list"]);
  });

  it("shows yearly prices with a per-month equivalent and an honest saving", () => {
    expect(getPlanPriceDisplay("plus", "yearly", defaultBillingAvailability)).toEqual({
      amount: "$24.99",
      note: "$2.08 a month, billed yearly",
      savingsPercent: 30,
      unit: "/year"
    });
    expect(getPlanPriceDisplay("family", "monthly", defaultBillingAvailability)).toMatchObject({
      amount: "$4.99",
      savingsPercent: null,
      unit: "/month"
    });
    expect(getPlanPriceDisplay("free", "yearly", defaultBillingAvailability)).toMatchObject({
      amount: "$0"
    });
    expect(getBestYearlySavings(defaultBillingAvailability)).toBe(30);
  });

  it("falls back to the other billing period, and to none while checkout is off", () => {
    const monthlyOnly: WebBillingAvailability = {
      ...availableEverywhere,
      plans: { ...availableEverywhere.plans, plus: { monthly: true, yearly: false } }
    };

    expect(
      getPurchasablePeriod("plus", "yearly", { availability: availableEverywhere, status: "ready" })
    ).toBe("yearly");
    expect(
      getPurchasablePeriod("plus", "yearly", { availability: monthlyOnly, status: "ready" })
    ).toBe("monthly");
    expect(
      getPurchasablePeriod("plus", "yearly", {
        availability: defaultBillingAvailability,
        status: "ready"
      })
    ).toBeNull();
    expect(
      getPurchasablePeriod("plus", "yearly", {
        availability: availableEverywhere,
        status: "loading"
      })
    ).toBeNull();
  });
});
