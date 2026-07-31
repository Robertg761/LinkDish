import { describe, expect, it } from "vitest";

import { formatMonthlyQuotaCopy } from "./quota-copy";

describe("formatMonthlyQuotaCopy", () => {
  it("prefers monthly quota fields when they are present", () => {
    expect(
      formatMonthlyQuotaCopy(
        {
          monthlyLimit: 5,
          remainingThisMonth: 1,
          resetsAt: "2026-08-01T00:00:00.000Z"
        },
        "You have used your free recipe imports."
      )
    ).toContain("1 of 5 left this month");
  });

  it("falls back to existing copy when monthly fields are absent", () => {
    expect(
      formatMonthlyQuotaCopy(
        {
          monthlyLimit: null,
          remainingThisMonth: null,
          resetsAt: null
        },
        "Free: 2 imports left"
      )
    ).toBe("Free: 2 imports left");
  });
});
