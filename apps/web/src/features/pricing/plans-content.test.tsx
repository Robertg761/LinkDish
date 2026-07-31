import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { defaultBillingAvailability, planContent, PricingPlansContent } from "./plans-content";

describe("PricingPlansContent", () => {
  it("renders plan copy from the shared plan-content module", () => {
    render(
      <PricingPlansContent
        billingAvailability={defaultBillingAvailability}
        currentPlan="free"
        renderPlanActions={() => <button type="button">Choose plan</button>}
        showFreePlan={false}
      />
    );

    expect(screen.getByRole("heading", { name: planContent.plus.name })).toBeInTheDocument();
    expect(screen.getByText("Better recovery for difficult recipe pages")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: planContent.family.name })).toBeInTheDocument();
    expect(screen.getByText("Real-time shared recipe syncing")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: planContent.free.name })).not.toBeInTheDocument();
  });

  it("describes the free save allowance and paid unlimited saves", () => {
    render(
      <PricingPlansContent billingAvailability={defaultBillingAvailability} currentPlan="free" />
    );

    const freeCard = screen
      .getByRole("heading", { name: planContent.free.name })
      .closest(".pricing-card");
    const plusCard = screen
      .getByRole("heading", { name: planContent.plus.name })
      .closest(".pricing-card");
    const familyCard = screen
      .getByRole("heading", { name: planContent.family.name })
      .closest(".pricing-card");

    expect(freeCard).not.toBeNull();
    expect(plusCard).not.toBeNull();
    expect(familyCard).not.toBeNull();
    expect(freeCard as HTMLElement).toHaveTextContent("15 saved recipes free");
    expect(plusCard as HTMLElement).toHaveTextContent("Unlimited saved recipes");
    expect(familyCard as HTMLElement).toHaveTextContent("Unlimited saved recipes");
  });
});
