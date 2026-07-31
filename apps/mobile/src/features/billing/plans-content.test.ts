import { describe, expect, it } from "vitest";

import { billingPlans } from "./plans";
import { freePlanFeatures, paidPlanFeatures, pricingNotes } from "./plans-content";

describe("plans-content", () => {
  it("keeps shared plan copy tied to billing plan limits", () => {
    expect(freePlanFeatures.join(" ")).toContain(
      `${billingPlans.free.limits.monthlyImports} recipe imports total`
    );
    expect(freePlanFeatures.join(" ")).toContain(
      `Save up to ${billingPlans.free.limits.savedRecipes} recipes free`
    );
    expect(paidPlanFeatures.plus.join(" ")).toContain(
      `${billingPlans.plus.limits.monthlyImports} recipe imports each month`
    );
    expect(paidPlanFeatures.family.join(" ")).toContain("Made for household sharing");
    expect(pricingNotes.map((note) => note.title)).toContain("Family plan");
  });
});
