import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHouseholdSummary } from "./use-household-summary";

import type { HouseholdSummary } from "./use-household-summary";
import type { HouseholdDetails } from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({
  getHousehold: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: { getHousehold: apiMocks.getHousehold }
}));

const household = { id: "household_a", role: "member" } as unknown as HouseholdDetails;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

interface Props {
  enabled: boolean;
  userId: string | undefined;
  credentialsKey: string | null;
}

const signedIn = (userId: string): Props => ({
  credentialsKey: `clerk:${userId}`,
  enabled: true,
  userId
});

const renderSummary = (initialProps: Props) => {
  const seen: HouseholdSummary[] = [];
  const view = renderHook(
    ({ credentialsKey, enabled, userId }: Props) => {
      const summary = useHouseholdSummary(enabled, userId, credentialsKey);
      seen.push(summary);
      return summary;
    },
    { initialProps }
  );

  return { ...view, seen };
};

describe("useHouseholdSummary", () => {
  beforeEach(() => {
    apiMocks.getHousehold.mockReset();
  });

  it("never shows one account's household to the next, even for a render", async () => {
    apiMocks.getHousehold
      .mockResolvedValueOnce({ household })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const { rerender, result, seen } = renderSummary(signedIn("user_a"));
    await waitFor(() => expect(result.current.household).toBe(household));

    seen.length = 0;
    // Clerk answers with a different account than the cached one.
    rerender(signedIn("user_b"));

    expect(seen.map((summary) => summary.household)).not.toContain(household);
    expect(result.current).toEqual({ household: null, status: "loading" });
  });

  it("forgets the household the moment the account signs out", async () => {
    apiMocks.getHousehold.mockResolvedValueOnce({ household });
    const { rerender, result, seen } = renderSummary(signedIn("user_a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    seen.length = 0;
    rerender({ credentialsKey: "session:", enabled: false, userId: undefined });

    expect(seen.map((summary) => summary.household)).not.toContain(household);
    expect(result.current).toEqual({ household: null, status: "idle" });
  });

  it("drops a late answer for the account that was signed in before", async () => {
    const late = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockReturnValueOnce(late.promise);
    apiMocks.getHousehold.mockResolvedValueOnce({ household: null });
    const { rerender, result } = renderSummary(signedIn("user_a"));

    rerender(signedIn("user_b"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      late.resolve({ household });
      await late.promise;
    });

    expect(result.current).toEqual({ household: null, status: "ready" });
  });

  it("waits for the account's credentials, and asks again when they change", async () => {
    apiMocks.getHousehold.mockResolvedValueOnce({ household });
    const next = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockReturnValueOnce(next.promise);
    const { rerender, result } = renderSummary({
      credentialsKey: null,
      enabled: true,
      userId: "user_a"
    });

    expect(result.current).toEqual({ household: null, status: "loading" });
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();

    rerender({ credentialsKey: "session:user_a", enabled: true, userId: "user_a" });
    await waitFor(() => expect(result.current.household).toBe(household));

    // Clerk signed the same account in late: ask again, keeping its answer meanwhile.
    rerender(signedIn("user_a"));
    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ household, status: "ready" });

    await act(async () => {
      next.resolve({ household: null });
      await next.promise;
    });

    expect(result.current).toEqual({ household: null, status: "ready" });
  });
});
