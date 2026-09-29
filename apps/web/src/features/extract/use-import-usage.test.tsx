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

describe("useImportUsageState freshness", () => {
  beforeEach(() => {
    mocks.auth = { credentialsKey: "clerk:user_1", isAuthenticated: true, loading: false };
    mocks.getBillingUsage.mockReset();
  });

  it("drops the last import's quota once another account signs in", async () => {
    mocks.getBillingUsage
      .mockResolvedValueOnce({ billingEnabled: true, quota: quota(2) })
      .mockResolvedValueOnce({ billingEnabled: true, quota: quota(3) });
    const { rerender, result } = renderHook(
      ({ latest }: { latest: QuotaStatus | null }) => useImportUsageState(latest, 0),
      { initialProps: { latest: null as QuotaStatus | null } }
    );
    await act(async () => {
      await Promise.resolve();
    });

    // user_1 imports; the response says 0 left.
    rerender({ latest: quota(0) });
    expect(result.current.usage?.remaining).toBe(0);

    mocks.auth = { credentialsKey: "clerk:user_2", isAuthenticated: true, loading: false };
    rerender({ latest: quota(0) });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.usage?.remaining).toBe(3);
  });

  it("asks again when queued imports finish, and shows the newer answer", async () => {
    const { invalidateImportUsage } = await import("./import-usage-signal");
    mocks.getBillingUsage
      .mockResolvedValueOnce({ billingEnabled: true, quota: quota(3) })
      .mockResolvedValueOnce({ billingEnabled: true, quota: quota(1) });
    const { rerender, result } = renderHook(
      ({ latest }: { latest: QuotaStatus | null }) => useImportUsageState(latest, 0),
      { initialProps: { latest: null as QuotaStatus | null } }
    );
    await act(async () => {
      await Promise.resolve();
    });
    // A direct import in this page left 2.
    rerender({ latest: quota(2) });
    expect(result.current.usage?.remaining).toBe(2);

    // The offline queue imports one more.
    await act(async () => {
      invalidateImportUsage();
      await Promise.resolve();
    });

    expect(mocks.getBillingUsage).toHaveBeenCalledTimes(2);
    expect(result.current.usage?.remaining).toBe(1);
    expect(result.current.pending).toBe(false);
  });
});
