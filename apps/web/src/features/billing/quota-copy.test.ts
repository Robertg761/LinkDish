import { describe, expect, it } from "vitest";

import { formatMonthlyQuotaCopy } from "./quota-copy";

describe("formatMonthlyQuotaCopy", () => {
  it("prefers monthly quota fields when present", () => {
    expect(
      formatMonthlyQuotaCopy(
        {
          monthlyLimit: 5,
          remainingThisMonth: 2,
          resetsAt: "2026-08-01T00:00:00.000Z"
        },
        "3 total imports left"
      )
    ).toMatch(/^2 of 5 left this month · resets /u);
  });

  it("falls back to total copy when monthly quota fields are absent", () => {
    expect(
      formatMonthlyQuotaCopy(
        {
          monthlyLimit: null,
          remainingThisMonth: null,
          resetsAt: null
        },
        "3 total imports left"
      )
    ).toBe("3 total imports left");
  });
});
