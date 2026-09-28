import { describe, expect, it } from "vitest";

import {
  getMonthlyEquivalentLabel,
  getPriceAmountLabel,
  getYearlySavingsPercent,
  parsePriceLabel
} from "./price-format";

describe("price labels", () => {
  it("reads the API's price labels", () => {
    expect(parsePriceLabel("$2.99/month")).toEqual({
      amount: 2.99,
      decimalSeparator: ".",
      prefix: "$",
      suffix: ""
    });
    expect(parsePriceLabel("CA$ 24.99 / year")).toMatchObject({ amount: 24.99, prefix: "CA$" });
    expect(parsePriceLabel("2,99 €/mois")).toMatchObject({
      amount: 2.99,
      decimalSeparator: ",",
      suffix: " €"
    });
    expect(parsePriceLabel("$29.99")).toMatchObject({ amount: 29.99 });
    expect(parsePriceLabel("Free")).toBeNull();
    expect(parsePriceLabel("$1,299.00/year")).toBeNull();
  });

  it("drops the billing period from a label", () => {
    expect(getPriceAmountLabel("$24.99/year")).toBe("$24.99");
    expect(getPriceAmountLabel("2,99 €/mois")).toBe("2,99 €");
    expect(getPriceAmountLabel("Contact us")).toBe("Contact us");
  });

  it("works out the per-month cost of a yearly plan", () => {
    expect(getMonthlyEquivalentLabel("$24.99/year")).toBe("$2.08");
    expect(getMonthlyEquivalentLabel("$44.99/year")).toBe("$3.75");
    expect(getMonthlyEquivalentLabel("n/a")).toBeNull();
  });

  it("rounds the yearly saving down so it is never overstated", () => {
    // 24.99 vs 12 × 2.99 = 35.88 → 30.35 %
    expect(getYearlySavingsPercent("$2.99/month", "$24.99/year")).toBe(30);
    // 44.99 vs 12 × 4.99 = 59.88 → 24.87 %
    expect(getYearlySavingsPercent("$4.99/month", "$44.99/year")).toBe(24);
    expect(getYearlySavingsPercent("$2.99/month", "$40.00/year")).toBeNull();
    expect(getYearlySavingsPercent("$2.99/month", "€24.99/year")).toBeNull();
    expect(getYearlySavingsPercent("soon", "$24.99/year")).toBeNull();
  });
});
