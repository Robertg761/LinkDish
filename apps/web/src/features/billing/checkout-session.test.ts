import { beforeEach, describe, expect, it } from "vitest";

import {
  CHECKOUT_SESSION_STORAGE_KEY,
  claimCheckoutSuccess,
  clearPendingCheckout,
  getPendingCheckout,
  rememberPendingCheckout,
  resetCheckoutSessionForTests
} from "./checkout-session";

describe("checkout session", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetCheckoutSessionForTests();
  });

  it("reports a started checkout once, with its plan and period", () => {
    rememberPendingCheckout({ period: "yearly", plan: "family", trigger: "household" });
    expect(getPendingCheckout()).toEqual({
      period: "yearly",
      plan: "family",
      trigger: "household"
    });

    expect(claimCheckoutSuccess()).toEqual({
      period: "yearly",
      plan: "family",
      trigger: "household"
    });
    expect(claimCheckoutSuccess()).toBeNull();
    expect(getPendingCheckout()).toBeNull();
  });

  it("still reports once when the success page opens without a known checkout", () => {
    expect(claimCheckoutSuccess()).toEqual({ plan: "unknown", trigger: "pricing" });
    expect(claimCheckoutSuccess()).toBeNull();
  });

  it("reports the next checkout after a previous one was counted", () => {
    rememberPendingCheckout({ period: "monthly", plan: "plus", trigger: "pricing" });
    expect(claimCheckoutSuccess()).toMatchObject({ plan: "plus" });

    rememberPendingCheckout({ period: "yearly", plan: "family", trigger: "pricing" });
    expect(claimCheckoutSuccess()).toMatchObject({ plan: "family", period: "yearly" });
    expect(claimCheckoutSuccess()).toBeNull();
  });

  it("forgets a checkout that never left the page", () => {
    rememberPendingCheckout({ period: "monthly", plan: "plus", trigger: "pricing" });
    clearPendingCheckout();

    expect(sessionStorage.getItem(CHECKOUT_SESSION_STORAGE_KEY)).toBeNull();
    expect(getPendingCheckout()).toBeNull();
  });

  it("ignores unreadable stored values", () => {
    sessionStorage.setItem(CHECKOUT_SESSION_STORAGE_KEY, "{not json");

    expect(getPendingCheckout()).toBeNull();
    expect(claimCheckoutSuccess()).toEqual({ plan: "unknown", trigger: "pricing" });
  });
});
