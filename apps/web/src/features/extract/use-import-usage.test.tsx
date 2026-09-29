import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useImportUsageState } from "./use-import-usage";

import type { QuotaStatus } from "@linkdish/api-contracts";

const mocks = vi.hoisted(() => ({
  auth: { credentialsKey: "clerk:user_1" as string | null, isAuthenticated: true, loading: false },
  getBillingUsage: vi.fn()
}));

vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => mocks.auth }));
vi.mock("../../api/client", () => ({ apiClient: { getBillingUsage: mocks.getBillingUsage } }));

const quota = (remaining: number): QuotaStatus => ({
  limit: 3,
  meteringMode: "free_lifetime",
  monthlyLimit: null,
  remaining,
  remainingThisMonth: null,
  resetsAt: null
});

describe("useImportUsageState", () => {
  beforeEach(() => {
    mocks.auth = { credentialsKey: "clerk:user_1", isAuthenticated: true, loading: false };
    mocks.getBillingUsage.mockReset();
  });

  it("never shows one account's allowance to the next, even for a render", async () => {
    mocks.getBillingUsage
      .mockResolvedValueOnce({ billingEnabled: true, quota: quota(1) })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const seen: Array<number | null> = [];
    const { rerender, result } = renderHook(() => {
      const state = useImportUsageState(null, 0);
      seen.push(state.usage?.remaining ?? null);
      return state;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.usage?.remaining).toBe(1);

    seen.length = 0;
    mocks.auth = { credentialsKey: "clerk:user_2", isAuthenticated: true, loading: false };
    rerender();

    // Not a single render of the new account shows the last account's "1 left".
    expect(seen).not.toContain(1);
    expect(result.current).toEqual({ pending: true, usage: null });
  });
});
